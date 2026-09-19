"""
HT801页面清单.py —— 列出网关网页里所有的页面链接；也可以直接看某一页的正文。

动机：这台 HT801 用的是老式 cgi-bin 界面，配置页是 /cgi-bin/config_a1、config_a2，
但状态页路径猜不出来（status / info / status_a1 全是 404）。
与其继续猜，不如直接从页面 HTML 里把菜单链接挖出来。
实测菜单是相对链接：index（状态）/ config / config2，绝对路径是 /cgi-bin/index 等。

用法（在 phone-companion 目录下）：
  $env:PYTHONIOENCODING='utf-8'; python 工具/诊断/HT801页面清单.py
  $env:PYTHONIOENCODING='utf-8'; python 工具/诊断/HT801页面清单.py /cgi-bin/index --text
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import ht801  # noqa: E402

SKIP_EXT = (".css", ".js", ".gif", ".png", ".jpg", ".ico", ".svg")

gw = ht801.Gateway(ht801.HOST, ht801.PASSWORD)
gw.login()

start = sys.argv[1] if len(sys.argv) > 1 else "/cgi-bin/config_a1"
page = gw._get(start)

# --text：只把这一页的可读正文打出来（脚本和样式先剔掉，否则全是代码噪音）
if "--text" in sys.argv:
    body = re.sub(r"<script.*?</script>", " ", page, flags=re.S | re.I)
    body = re.sub(r"<style.*?</style>", " ", body, flags=re.S | re.I)
    body = re.sub(r"<[^>]+>", " ", body)
    body = re.sub(r"&nbsp;", " ", body)
    body = re.sub(r"\s+", " ", body)
    print(f"{start} 正文（{len(page)} 字节）：\n")
    print(body.strip())
    sys.exit(0)

print(f"{start} 共 {len(page)} 字节\n")

# href / action / src 三种属性都扫，顺便把 onclick 里的跳转也捞出来
found = set()
for attr in ("href", "action", "src"):
    for m in re.finditer(attr + r'\s*=\s*"([^"]+)"', page, re.I):
        found.add(m.group(1))
    for m in re.finditer(attr + r"\s*=\s*'([^']+)'", page, re.I):
        found.add(m.group(1))
for m in re.finditer(r'location\s*=\s*[\'"]([^\'"]+)[\'"]', page, re.I):
    found.add(m.group(1))

items = []
base_dir = start.rsplit("/", 1)[0]                 # 例：/cgi-bin/config_a1 → /cgi-bin
for link in sorted(found):
    low = link.lower()
    if low.startswith(("http", "javascript:", "mailto:", "#")):
        continue
    if low.endswith(SKIP_EXT):
        continue
    # 页面里的链接是相对的（index / config2 / rs …），补成绝对路径才能直接请求
    if not link.startswith("/"):
        link = base_dir + "/" + link.lstrip("./")
    items.append(link)

print(f"=== 页面链接（{len(items)} 条）===")
for link in items:
    print(f"  {link}")

# 逐个试一下，标出哪些真能打开、里面有什么
print("\n=== 逐个探测 ===")
for link in items:
    try:
        body = gw._get(link)
    except Exception as exc:                     # noqa: BLE001
        print(f"  ✗ {link:28} {type(exc).__name__}")
        continue
    text = re.sub(r"<[^>]+>", " ", body)
    text = re.sub(r"\s+", " ", text).strip()
    print(f"  ✓ {link:28} {len(body):>6} 字节  {text[:130]}")
