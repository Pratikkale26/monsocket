import { createRoot } from "react-dom/client";
import App from "./App";
import Standoff from "./standoff/Standoff";
import "./styles.css";

// The arcade's whole router: one query param picks the cabinet. Both games
// share the wallet, the SDK client and the stylesheet.
const game = new URLSearchParams(location.search).get("game");

createRoot(document.getElementById("root")!).render(
  game === "standoff" ? <Standoff /> : <App />,
);
