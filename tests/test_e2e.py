import os, time
from playwright.sync_api import sync_playwright

EXT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "extension"))
VIDEO_URL = "https://www.youtube.com/watch?v=JGwWNGJdvx8"
VIDEO_ID = "JGwWNGJdvx8"

def main():
    p = sync_playwright().start()
    ctx = p.chromium.launch_persistent_context(
        user_data_dir="/tmp/ytext-e2e-profile",
        channel="chromium",
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
        headless=False,
    )
    try:
        page = ctx.new_page()
        page.goto(VIDEO_URL, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(6000)

        # Button should be injected
        btn = page.locator("#ytl-action")
        btn.wait_for(timeout=15000)
        print("button text:", btn.inner_text())
        print("status:", page.locator("#ytl-status").inner_text())

        # Click Save locally
        btn.click()
        page.wait_for_timeout(3000)
        print("after click status:", page.locator("#ytl-status").inner_text())

        # Poll the host for the video to complete
        import urllib.request, json
        for i in range(60):
            try:
                st = json.loads(urllib.request.urlopen(f"http://127.0.0.1:8717/api/status/{VIDEO_ID}", timeout=5).read())
                print(f"t={i*3}s status: cached={st.get('cached')} complete={st.get('complete')} size={st.get('size')}")
                if st.get("complete"):
                    break
            except Exception as e:
                print("status err:", e)
            time.sleep(3)

        # Button should switch to Play locally
        try:
            page.wait_for_function(
                "document.querySelector('#ytl-action')?.dataset?.mode === 'play'",
                timeout=20000,
            )
            print("FINAL button mode:", page.locator("#ytl-action").get_attribute("data-mode"))
        except Exception as e:
            print("button did not switch:", str(e)[:120])
    finally:
        ctx.close()
        p.stop()

if __name__ == "__main__":
    main()
