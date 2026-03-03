import { render } from "preact/compat";
import { App } from "./app.js";

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
}
