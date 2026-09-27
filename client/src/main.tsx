import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import SymbolCursor from "./components/SymbolCursor";

createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <SymbolCursor />
  </>,
);

/*StrictMode>
    <App />
  </StrictMode>,*/
