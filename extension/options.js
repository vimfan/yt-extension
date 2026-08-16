// Options page for YT Local player preference.
const radios = document.querySelectorAll('input[name="player"]');
const saveBtn = document.getElementById("save");
const msg = document.getElementById("msg");

function read() {
  return new Promise((r) => chrome.storage.sync.get({ playerChoice: "ask" }, r));
}

async function load() {
  const { playerChoice } = await read();
  for (const el of radios) {
    if (el.value === playerChoice) el.checked = true;
  }
}

saveBtn.addEventListener("click", async () => {
  const selected = [...radios].find((el) => el.checked);
  const value = selected ? selected.value : "ask";
  await chrome.storage.sync.set({ playerChoice: value });
  msg.textContent = "Saved ✓";
  setTimeout(() => { msg.textContent = ""; }, 2000);
});

load();
