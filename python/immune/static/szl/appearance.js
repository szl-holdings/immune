/* In-memory presentation only. No network, storage or authority mutation. */
(() => {
  "use strict";
  const button = document.getElementById("appearance");
  if (!button) return;
  function update() {
    const dark = document.documentElement.dataset.surface !== "light";
    button.setAttribute("aria-label", `Use ${dark ? "light" : "dark"} appearance`);
    const label = button.querySelector(".appearance-label");
    if (label) label.textContent = dark ? "Light" : "Dark";
  }
  button.hidden = false;
  button.addEventListener("click", () => {
    document.documentElement.dataset.surface = document.documentElement.dataset.surface === "light" ? "dark" : "light";
    update();
  });
  update();
})();
