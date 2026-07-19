import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { App } from "./App";
import { ReleaseProvider } from "./lib/release/ReleaseContext";
import "./index.css";

const Router =
  import.meta.env.VITE_ROUTER_MODE === "hash" ? HashRouter : BrowserRouter;
const basename = import.meta.env.BASE_URL === "/" ? undefined : import.meta.env.BASE_URL;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Router basename={basename}>
      <ReleaseProvider>
        <App />
      </ReleaseProvider>
    </Router>
  </React.StrictMode>,
);
