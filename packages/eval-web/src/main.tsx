import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import { DatasetApp } from "./DatasetApp";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Eval Web root is missing.");

createRoot(root).render(
  <StrictMode><DatasetApp /></StrictMode>,
);
