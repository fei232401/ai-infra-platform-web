# platform CI —— ai-infra-platform-web 的镜像构建流水线

这份流水线是 `platform-ci`（api）的**第三个实例**。它与 api 版长得像，但**少了两个 stage、多了一个 stage**，
这三处正是「前端仓接流水线」与「后端仓接流水线」的全部区别。

## 它做什么

```
Gitea push (ai-infra-platform-web)
        │  webhook: http://k3d-ai-cluster-server-0:30080/generic-webhook-trigger/invoke?token=***
        v
Jenkins job `platform-web-ci`  （SCM: gitea:3000/fei232401/ai-infra-platform-web.git，分支 */main）
        │
        ├─ 1. Checkout        从私有仓检出代码（走 Jenkins 凭据 gitea-scm）
        ├─ 2. Trigger Guard   只看本次推送碰了没碰 src/ ci/ Dockerfile nginx.conf
        │                     index.html tsconfig.json vite.config.ts package.json package-lock.json
        ├─ 3. Resolve Tag     IMAGE_REF = k3d-sre-registry:5000/platform/ai-infra-platform-web:<short sha>
        ├─ 4. Typecheck       npm ci && npm run typecheck（tsc --noEmit）
        ├─ 5. Build           buildah bud：多阶段 —— node:20-alpine 里 npm ci + vite build
        │                     → nginx:1.27-alpine 只装 dist/ + nginx.conf
        ├─ 6. Push            buildah push → k3d-sre-registry:5000
        ├─ 7. Verify In Registry  查 registry 的 tags/list 里确实有这颗 sha
        └─ 8. Update GitOps   sed 改 sre-lab-gitops/production/apps/ai-platform/web.yaml 的 image tag
                              → push 回 sre-lab 仓 → ArgoCD 收敛 → 滚动更新
```

## 与 api 版（platform-ci）的差异：少两个、多一个

| 差异 | platform-ci（api） | platform-web-ci（web） | 为什么 |
|---|---|---|---|
| **Fetch Schema** | 有 | **没有** | 前端不读数据库。db 仓的 schema 契约与 web 无关，没有要拉的私有仓依赖 |
| **Migrate** | 有 | **没有** | 没有表结构要迁移。这一条最值得讲：*「迁移该不该进 CI」不是流水线规矩，而是「这个仓有没有 schema 所有权」的函数* |
| **Typecheck** | 没有（用 pytest 替代） | **有** | 前端的「测试」在 MVP 阶段不是跑用例，而是 `tsc --noEmit` + 构建。类型错误就是最有价值的那类失败信号，且比 Docker 构建快一个数量级 |
| Test 容器 | `python:3.11-slim` + pytest（82 用例，打集群内 PG） | `node:20-slim` + `npm run typecheck` | 语言栈不同 |
| 镜像形态 | 单阶段 `python:3.11-slim` + uvicorn | **多阶段**：`node:20-alpine` 构建 → `nginx:1.27-alpine` 托管静态产物 | 前端最终产物是静态文件，运行容器不需要 node、不需要源码、不需要 devDependencies |
| buildah PVC | `buildah-storage-platform` | `buildah-storage-web` | 两个 job 用 vfs 驱动，若共用同一块 PVC 且并发，会同时改写 `/var/lib/containers/storage`。**必须各占一块**（`disableConcurrentBuilds()` 只管单个 job 内部） |
| post 告警钩子 | 有（`ci/notify_alertmanager.py` fire/resolve） | **没有** | web 的构建容器是 node，没有 python；要照搬得再加一个 python 容器，或把 notify 改写成 node。当前版本不做，记为已知差异 |

**共同点**（这两条是两条流水线共享的骨架，不因语言而变）：
- **Test → Build → 写回 GitOps 的顺序**：`Update GitOps` 是唯一的对外副作用，放最后；前面任何一步红了，集群保持在上一个可用版本。
- **首次落地守卫**：清单不存在时跳过写回而不是报错，让引导顺序可以「先跑通镜像，再落清单」。

## nginx 为什么必须反代 /api

web 的 API 基址是 `import.meta.env.VITE_API_BASE_URL ?? ""`（见 `src/api/client.ts`）。
生产环境不设这个变量 → 所有请求都是**同源相对路径**（`/api/v1/...`）。
所以托管它的 nginx 必须把 `/api/`、`/healthz`、`/readyz`、`/openapi.json` 反代到
`ai-infra-platform-api.ai-platform.svc.cluster.local:8000`，否则前端一加载就是一堆 404。

这也解释了为什么 `vite.config.ts` 里 dev 环境要配同样的 proxy —— **dev 与生产是两套实现、同一份契约**。

> 已知缺口：`src/api/client.ts` 目前**不发 `X-API-Key` 请求头**，而生产环境 `AUTH_REQUIRED=true`。
> 结果是控制台能加载页面、能调到 `/healthz`，但所有 `/api/v1/*` 都是 401。
> 「前端 → 控制层」这条链路要真正打通，还需要在前端补上 API Key 的持有与随请求发送。详见 `docs/02_接入层.md`。

## 需要什么才能复现

| 类型 | 名称 | 用途 |
|---|---|---|
| Jenkins 凭据 | `gitea-scm`（Username with password） | 私有仓 SCM 检出（与 api 共用） |
| Jenkins 凭据 | `platform-webhook-token`（Secret text） | GenericTrigger 的 token（与 api 共用） |
| K8s Secret | `jenkins/gitea-netrc`（key: `netrc`） | Pod 内 clone/push 私有仓与 GitOps 仓（与 api 共用） |
| K8s ConfigMap | `jenkins/buildah-registries` | buildah 走 daocloud 镜像源（与 api 共用） |
| K8s PVC | `jenkins/buildah-storage-web` | buildah 的 vfs 存储（**web 独占**） |
| Jenkins 插件 | generic-webhook-trigger 2.4.3 / kubernetes 4547 / git 5.10.1 | —— |

## 加第四个服务要改什么

1. 复制这份 Jenkinsfile，改 `IMAGE_NAME` / `SERVICE_NAME` / `PIPELINE_TITLE` / `GITOPS_FILE`，
   并按「有没有 schema 所有权 / 用什么语言」决定要不要保留 Typecheck、Fetch Schema、Migrate
2. **新开一块 buildah PVC**（除非确信永不并发）
3. Jenkins 建 job（SCM 指向新仓、挂 `gitea-scm`、GenericTrigger 用同一个 `platform-webhook-token`）
4. 新仓挂 webhook
5. GitOps 仓里建好被 sed 的那份清单（`image:` 那一行必须先存在）
