const $ = (id) => document.getElementById(id);

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " KB";
  return n + " B";
}

function send(msg, cb) {
  chrome.runtime.sendMessage(msg, cb);
}

async function refresh() {
  $("err").textContent = "";
  send({ type: "list" }, (res) => {
    if (!res) {
      $("list").innerHTML = '<div class="empty">No response</div>';
      return;
    }
    if (!res.items) {
      $("list").innerHTML = '<div class="empty">Host not reachable</div>';
      return;
    }
    $("usage").textContent = `${fmt(res.total_bytes)} / ${fmt(res.max_bytes)}`;
    const list = $("list");
    if (!res.items.length) {
      list.innerHTML = '<div class="empty">Nothing cached yet.</div>';
      return;
    }
    list.innerHTML = res.items
      .map(
        (it) => `
        <div class="item">
          <div class="info">
            <div class="title">${esc(it.title || it.video_id)}</div>
            <div class="sub">${fmt(it.size)} · ${it.complete ? "ready" : "in progress"}</div>
          </div>
          <button title="Delete" data-id="${it.video_id}">🗑</button>
        </div>`
      )
      .join("");
    list.querySelectorAll("button[data-id]").forEach((b) =>
      b.addEventListener("click", () => del(b.dataset.id))
    );
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function del(id) {
  send({ type: "deleteVideo", videoId: id }, refresh);
}

$("refresh").addEventListener("click", refresh);
$("purge").addEventListener("click", () => {
  send({ type: "purge" }, () => {
    $("err").textContent = "Purged.";
    refresh();
  });
});

refresh();
