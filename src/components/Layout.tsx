import { Outlet } from "react-router-dom";

import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export function Layout() {
  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <Topbar />
        <Outlet />
      </div>
    </div>
  );
}
