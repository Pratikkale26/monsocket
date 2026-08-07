import { createRoot } from "react-dom/client";
import Arcade from "./arcade/Arcade";
import "./styles.css";
import "./arcade.css";

createRoot(document.getElementById("root")!).render(<Arcade />);
