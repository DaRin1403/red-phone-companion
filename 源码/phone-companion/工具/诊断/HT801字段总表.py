"""
HT801字段总表.py —— 把网关配置页里所有字段连标签一起摊开，用来找"关键项"列表没覆盖的设置。

动机：
  ht801.py inspect 只比对 7 个已知关键项，看不出别的设置（比如自动接听）。
  真机验证回铃时，我们发 INVITE 后先收到 180（在振铃）、紧接着就是 200（被接听），
  可当时没人在家 —— 必须确认是设备开了自动接听、还是话机没挂好。

  只看字段名没用：页面里全是 P340 这种编号，含义在旁边的中文标签里。
  所以这里把"字段 → 标签 → 值"配对输出。

用法（在 phone-companion 目录下）：
  $env:PYTHONIOENCODING='utf-8'; python 工具/诊断/HT801字段总表.py
"""
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import ht801  # noqa: E402

# 运行产物统一放 .runtime\，不让诊断输出散在源码目录里
RUNTIME_DIR = PROJECT_ROOT / ".runtime"
RUNTIME_DIR.mkdir(exist_ok=True)
OUT = RUNTIME_DIR / "HT801字段总表.txt"

# Grandstream 的配置分散在 a/b/c 若干页；已知 a1、a2 有效，其余顺手试探
PAGES = [
    "/cgi-bin/config_a1",
    "/cgi-bin/config_a2",
    "/cgi-bin/config_a3",
    "/cgi-bin/config_b1",
    "/cgi-bin/config_b2",
    "/cgi-bin/config_c1",
    "/cgi-bin/config_d1",
]

# 命中这些词（标签或取值里）的字段单独拎出来
KEYWORDS = ["answer", "auto", "ring", "hook", "接听", "响铃", "振铃", "摘机", "自动", "呼叫等待"]

# 页面上可读的一段文字（标签通常就长这样）
TEXT_RE = re.compile(r">([^<>]{1,80})<")
# 字段在 HTML 里的出现位置
NAME_RE_TMPL = r'<[^>]*\bname\s*=\s*["\']?{name}["\']?[^>]*>'


def label_for(html_text: str, name: str, window: int = 500) -> str:
    """找 name 这个字段前面最近的一段可读文字，当作它的标签。"""
    m = re.search(NAME_RE_TMPL.format(name=re.escape(name)), html_text, re.I)
    if not m:
        return ""
    chunk = html_text[max(0, m.start() - window):m.start()]
    best = ""
    for t in TEXT_RE.finditer(chunk):
        text = t.group(1).strip()
        if not text or not re.search(r"[\u4e00-\u9fff A-Za-z]", text):
            continue
        best = text
    return best


gw = ht801.Gateway(ht801.HOST, ht801.PASSWORD)
gw.login()
print(f"已登录 {ht801.HOST}\n")

lines = []
all_fields = []          # (page, name, value, label, options)

for page in PAGES:
    try:
        page_html = gw._get(page)
    except Exception as exc:                     # noqa: BLE001
        print(f"  {page:22} 取不到（{type(exc).__name__}）")
        continue
    values, meta = ht801.parse_form(page_html)
    if not values:
        print(f"  {page:22} 无字段")
        continue
    print(f"  {page:22} {len(values):4} 个字段")
    lines.append(f"\n=== {page} （{len(values)} 个字段）===")
    for name in sorted(values, key=lambda n: (len(n), n)):
        options = meta.get(name, {}).get("options")
        label = label_for(page_html, name)
        all_fields.append((page, name, values[name], label, options))
        extra = f"  选项={options}" if options else ""
        lines.append(f"  {name:>8} = {str(values[name]):<22} 标签={label!r}{extra}")

lines.append("\n\n=== 疑似与响铃/接听有关的字段 ===")
print("\n=== 疑似与响铃/接听有关的字段 ===")
hits = 0
for page, name, value, label, options in all_fields:
    blob = f"{name} {value} {label} {options}".lower()
    if any(k.lower() in blob for k in KEYWORDS):
        row = f"  {name:>8} = {str(value):<22} 标签={label!r}   ({page})"
        lines.append(row)
        print(row)
        hits += 1
if not hits:
    lines.append("  （没有命中）")
    print("  （没有命中）")

OUT.write_text("\n".join(lines), encoding="utf-8")
print(f"\n共 {len(all_fields)} 个字段，完整表写进 {OUT}")
