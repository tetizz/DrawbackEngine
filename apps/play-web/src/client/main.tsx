import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("The local play root element is missing.");
}
createRoot(root).render(<App />);
