import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Intentionally not <StrictMode>: terminal sessions are real side effects and must not mount twice.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);

// Native-feeling: no browser context menu / reload keys in production
window.addEventListener("contextmenu", (e) => { if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault(); });
