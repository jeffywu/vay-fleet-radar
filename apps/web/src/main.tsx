import { createRoot } from "react-dom/client";
import "mapbox-gl/dist/mapbox-gl.css";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root application mount");
createRoot(root).render(<App />);

