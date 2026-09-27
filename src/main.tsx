import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import RingRender from "./viewer/RingRender.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.hash.startsWith("#ring-render=") ? <RingRender assetId={decodeURIComponent(location.hash.slice("#ring-render=".length))} /> : <App />}
  </StrictMode>,
);
