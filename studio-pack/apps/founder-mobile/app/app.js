const stateKey = "startup-studio-mobile-shell-v1";
const input = document.getElementById("ideaInput");
const buttons = document.querySelectorAll(".action-list button");

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(stateKey) || "{}");
  } catch {
    return {};
  }
}

function saveState(selectedAction) {
  localStorage.setItem(
    stateKey,
    JSON.stringify({
      idea: input.value,
      selectedAction,
      updatedAt: new Date().toISOString(),
    })
  );
}

const saved = loadState();
if (saved.idea) input.value = saved.idea;

buttons.forEach((button) => {
  if (button.dataset.action === saved.selectedAction) button.classList.add("is-selected");
  button.addEventListener("click", () => {
    buttons.forEach((item) => item.classList.remove("is-selected"));
    button.classList.add("is-selected");
    saveState(button.dataset.action);
  });
});

input.addEventListener("input", () => {
  const selected = document.querySelector(".action-list button.is-selected")?.dataset.action || "idea";
  saveState(selected);
});
