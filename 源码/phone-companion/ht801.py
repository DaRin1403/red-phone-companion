# -*- coding: utf-8 -*-
"""
ht801.py —— Grandstream HT801/HT802 配置工具（适配老式 cgi-bin 界面）

为什么需要它：这台 HT801 用的是 2010 年代的老式网页界面，
配置表单是**整体提交**的（POST 所有字段到 /cgi-bin/update），
不能只提交改动项。所以必须：
  1. 登录（POST /cgi-bin/dologin，字段 P2=密码）
  2. 抓取目标配置页，解析出**全部字段的当前状态**
  3. 只修改我们关心的项，其余原样回填
  4. 整体 POST 提交
  5. 回读验证

用法：
  python ht801.py inspect          # 只读，打印关键项当前值
  python ht801.py configure        # 写入（自动备份原值）
  python ht801.py restore          # 回滚

环境变量：
  HT801_HOST     网关地址        默认 172.50.1.103
  HT801_PASSWORD 管理密码        默认 admin
  HT801_LOCAL    本机 SIP 地址   默认自动探测
  HT801_SIP_PORT 本机 SIP 端口   默认 5090
  HT801_PAGE     配置页路径      默认 /cgi-bin/config_a1
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

HOST = os.environ.get("HT801_HOST", "172.50.1.103")
PASSWORD = os.environ.get("HT801_PASSWORD", "admin")
SIP_PORT = os.environ.get("HT801_SIP_PORT", "5090")
PAGE = os.environ.get("HT801_PAGE", "/cgi-bin/config_a1")
BACKUP = Path(__file__).resolve().parent / ".runtime" / "ht801-original.json"

# 要修改的项：P 值 → 目标值
# 说明见 docs：P47 主SIP服务器 / P35 SIP用户ID / P31 SIP注册 /
#              P71 摘机自动拨号 / P4045 拨号延迟 / P850 DTMF负载类型 / P870 DTMF方式
DESIRED = {
    "P35": "companion",     # SIP 用户 ID
    "P31": "0",             # SIP 注册：关闭（直连方案不注册）
    "P71": "263",           # 摘机自动拨号：拨到本机 SIP 服务
    "P4045": "0",           # 拨号延迟：0 秒
    "P850": "101",          # DTMF 负载类型
    "P870": "0",            # DTMF 方式：RFC2833
}
# P47 单独处理：要带端口 → <本机IP>:5090

# 铃音节奏：响 1 秒、停 1 秒（设备默认是 2000/4000，即响 2 秒停 4 秒）。
# ⚠️ 这个值必须和 phone.config.json 里的 ringCadenceOnMs / ringCadenceOffMs 一致！
#    "回铃响几声"是靠这个节奏推算的（SIP 只在开始振铃时回一次 180，之后每响一声
#    都没有通知），两边不一致 → 说好响一次会变成响两次或只有半声。
#    inspect 会把不一致直接标出来，所以改完两边都用 inspect 核一遍。
#
# 为什么 10 个铃音全改：不确定设备实际启用哪一个（默认它们都是 2000/4000），
# 全部设成一致最保险。
RING_CADENCE = "c=1000/1000;"
for _i in range(4010, 4020):
    DESIRED[f"P{_i}"] = RING_CADENCE


# 配置页的 <form action="update"> 是**相对地址**，所以提交地址 = 配置页所在目录 + /update
# 例：页面 /cgi-bin/config_a1 → 提交 /cgi-bin/update
# （早先写成 '页面/../update' 再 replace，会把 /cgi-bin 一并吃掉，变成 /update —— 必须避免）
def update_path(page: str = None) -> str:
    return (page or PAGE).rsplit("/", 1)[0] + "/update"


def user_local_ip() -> str:
    """探测本机在网关网段上的地址（用于告诉网关往哪儿发 SIP）。"""
    import socket
    explicit = os.environ.get("HT801_LOCAL")
    if explicit:
        return explicit
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((HOST, 80))          # 不发包，只为让内核选路由
        return s.getsockname()[0]
    except Exception:
        return "172.50.1.2"
    finally:
        s.close()


class Gateway:
    def __init__(self, host: str, password: str):
        self.base = f"http://{host}"
        self.password = password
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.ProxyHandler({}),      # 局域网设备不走代理
        )

    def _get(self, path: str) -> str:
        req = urllib.request.Request(self.base + path)
        req.add_header("User-Agent", "Mozilla/5.0 (phone-companion)")
        with self.opener.open(req, timeout=15) as r:
            return r.read().decode("utf-8", "replace")

    def _post(self, path: str, data: dict) -> str:
        body = urllib.parse.urlencode(data).encode()
        req = urllib.request.Request(self.base + path, data=body)
        req.add_header("User-Agent", "Mozilla/5.0 (phone-companion)")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("Referer", self.base + PAGE)
        with self.opener.open(req, timeout=20) as r:
            return r.read().decode("utf-8", "replace")

    def login(self) -> None:
        self._get("/cgi-bin/login")            # 拿 session cookie
        resp = self._post("/cgi-bin/dologin", {"P2": self.password, "gnkey": "0b82", "Login": "Login"})
        if "密码错误" in resp or "password" in resp.lower() and "incorrect" in resp.lower():
            raise RuntimeError("登录失败：密码不对")
        if "session_id" not in "".join(str(c) for c in self.jar):
            raise RuntimeError("登录失败：没拿到 session cookie")

    def fetch_page(self) -> str:
        return self._get(PAGE)


# ---------------------------------------------------------------- 表单解析

TAG_RE = re.compile(r"<(input|select|textarea)\b([^>]*)>", re.I | re.S)
ATTR_RE = re.compile(r'([\w\-.]+)\s*=\s*("([^"]*)"|\'([^\']*)\'|([^\s">]+))', re.S)


def _attrs(tag: str) -> dict:
    out = {}
    for m in ATTR_RE.finditer(tag):
        name = m.group(1).lower()
        val = m.group(3) if m.group(3) is not None else (
            m.group(4) if m.group(4) is not None else m.group(5))
        out[name] = html.unescape(val or "")
    return out


def parse_form(page: str) -> tuple[dict, dict]:
    """
    解析配置页里的所有字段。
    返回 (values, meta)：
      values —— 可直接回填提交的 名字→值
      meta   —— 名字→{type, options, current}
    """
    values: dict[str, str] = {}
    meta: dict[str, dict] = {}

    # 先按出现顺序扫描，遇到 select 时收集其 option（含 selected）
    tokens = list(TAG_RE.finditer(page))
    i = 0
    while i < len(tokens):
        m = tokens[i]
        kind = m.group(1).lower()
        a = _attrs(m.group(2))
        name = a.get("name")
        if not name:
            i += 1
            continue

        if kind == "select":
            # 找对应的 </select>，收集 option
            end = page.find("</select>", m.end())
            seg = page[m.end():end if end != -1 else m.end() + 4000]
            opts = []
            current = None
            for om in re.finditer(r"<option\b([^>]*)>", seg, re.I):
                oa = _attrs(om.group(1))
                otext = seg[om.end(): seg.find("<", om.end())].strip()
                val = oa.get("value", otext)
                opts.append(val)
                if "selected" in om.group(1).lower() or "selected" in oa:
                    current = val
            if current is None and opts:
                current = opts[0]
            values[name] = current or ""
            meta[name] = {"type": "select", "options": opts, "current": current}
        elif kind == "input":
            itype = (a.get("type") or "text").lower()
            if itype in ("checkbox", "radio"):
                if "checked" in m.group(2).lower():
                    values[name] = a.get("value", "1")
                    meta[name] = {"type": itype, "current": a.get("value", "1"), "checked": True}
                else:
                    meta.setdefault(name, {"type": itype, "current": None, "checked": False})
            elif itype in ("submit", "button", "reset", "image", "file"):
                pass                                   # 不提交按钮类
            else:
                values[name] = a.get("value", "")
                meta[name] = {"type": itype, "current": a.get("value", "")}
        elif kind == "textarea":
            end = page.find("</textarea>", m.end())
            txt = page[m.end():end] if end != -1 else ""
            values[name] = html.unescape(txt.strip())
            meta[name] = {"type": "textarea", "current": values[name]}
        i += 1

    return values, meta


# ---------------------------------------------------------------- 主流程

def do_inspect(gw: Gateway) -> int:
    gw.login()
    page = gw.fetch_page()
    values, meta = parse_form(page)
    local = user_local_ip()
    target = {**DESIRED, "P47": f"{local}:{SIP_PORT}"}

    print(f"网关 {HOST}   本机 {local}   配置页 {PAGE}")
    print(f"解析出 {len(values)} 个可提交字段\n")
    print("=== 关键项 ===")
    all_ok = True
    for k in list(DESIRED) + ["P47"]:
        want = target[k]
        have = values.get(k)
        ok = (have == want)
        if not ok:
            all_ok = False
        m = meta.get(k, {})
        extra = f"  选项={m.get('options')}" if m.get("type") == "select" else ""
        print(f"  {'✓' if ok else '✗'} {k:>7}  现在={have!r:28} 期望={want!r}{extra}")
    print()
    print("结论：" + ("配置已符合预期。" if all_ok else "有项不符，执行 configure 写入。"))
    return 0 if all_ok else 2


def _submit(gw: Gateway, values: dict, changes: list[str]) -> int:
    """把改好的 values 提交上去并回读验证（configure 与 set 共用）。"""
    if not changes:
        print("没有需要修改的项。")
        return do_inspect(gw)
    print("将修改：")
    for c in changes:
        print(f"  {c}")

    # ⚠️ 关键：必须把提交按钮自身也作为一个字段提交
    # （页面里是 <input type="submit" name="update" value="保存">）。
    # 漏掉它服务器会直接关闭连接（RemoteDisconnected），配置完全不写入。
    # 实测踩过这个坑，排查花了很久。
    values["update"] = "保存"
    values.setdefault("gnkey", "0b82")

    print(f"\n提交 {len(values)} 个字段到 {update_path()} …")
    try:
        resp = gw._post(update_path(), values)
    except Exception as exc:
        # 设备应用配置时可能直接断开连接，属正常现象
        print(f"（连接被设备关闭：{type(exc).__name__} —— 应用配置时常见，继续回读验证）")
        resp = ""
    if resp and ("错误" in resp or "error" in resp.lower()):
        snippet = re.sub(r"<[^>]+>", " ", resp)
        snippet = re.sub(r"\s+", " ", snippet).strip()[:300]
        print(f"⚠️ 提交返回可能含错误：{snippet}")
    else:
        print("提交完成。")

    print("\n=== 回读验证 ===")
    return do_inspect(gw)


def do_set(gw: Gateway, pairs: list[str]) -> int:
    """
    通用写入：把任意的 P 值改成指定值。

    为什么需要它：configure 只能套用一份写死的 DESIRED 预设，
    想调铃音节奏（P4010）、振铃超时（P185）这类项就得手改代码。
    真机上要"把铃声改密一点"时就是这么卡住的，所以补一个通用入口。

    用法：python ht801.py set P4010='c=1000/1000;' P4011='c=1000/1000;'
    """
    gw.login()
    page = gw.fetch_page()
    values, _meta = parse_form(page)
    if not values:
        print("✗ 没解析到任何字段，先确认登录是否成功")
        return 1

    BACKUP.parent.mkdir(parents=True, exist_ok=True)
    if not BACKUP.exists():
        BACKUP.write_text(json.dumps(values, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"已备份 {len(values)} 个字段原值到 {BACKUP}")

    changes = []
    for pair in pairs:
        if "=" not in pair:
            print(f"✗ 参数格式应为 KEY=VALUE，收到：{pair}")
            return 1
        key, _, want = pair.partition("=")
        key = key.strip()
        if key not in values:
            # 拼错字段名是最容易犯的错，宁可直接报错也不要静默提交（会污染整页配置）
            print(f"✗ 配置页里没有字段 {key}（检查一下拼写；可用 inspect 或字段总表查）")
            return 1
        if values[key] != want:
            changes.append(f"{key}: {values[key]!r} → {want!r}")
            values[key] = want

    return _submit(gw, values, changes)


def do_configure(gw: Gateway) -> int:
    gw.login()
    page = gw.fetch_page()
    values, _meta = parse_form(page)
    if not values:
        print("✗ 没解析到任何字段，先确认登录是否成功")
        return 1

    local = user_local_ip()
    changes = {**DESIRED, "P47": f"{local}:{SIP_PORT}"}

    # 备份原值
    BACKUP.parent.mkdir(parents=True, exist_ok=True)
    if not BACKUP.exists():
        BACKUP.write_text(json.dumps(values, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"已备份 {len(values)} 个字段原值到 {BACKUP}")
    else:
        print(f"原值基线已存在，不覆盖：{BACKUP}")

    diffs = []
    for k, v in changes.items():
        if values.get(k) != v:
            diffs.append(f"{k}: {values.get(k)!r} → {v!r}")
            values[k] = v

    return _submit(gw, values, diffs)


def do_restore(gw: Gateway) -> int:
    if not BACKUP.exists():
        print(f"✗ 没有备份 {BACKUP}")
        return 1
    gw.login()
    values = json.loads(BACKUP.read_text(encoding="utf-8"))
    print(f"回滚 {len(values)} 个字段…")
    gw._post(update_path(), values)
    print("已提交回滚。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="HT801 配置工具（老式 cgi-bin 界面）")
    ap.add_argument("action", choices=["inspect", "configure", "set", "restore"])
    ap.add_argument("pairs", nargs="*", help="set 用：KEY=VALUE，可给多个")
    args = ap.parse_args()

    gw = Gateway(HOST, PASSWORD)
    try:
        if args.action == "inspect":
            return do_inspect(gw)
        if args.action == "configure":
            return do_configure(gw)
        if args.action == "set":
            if not args.pairs:
                print("用法：python ht801.py set P4010='c=1000/1000;' [更多 KEY=VALUE]")
                return 2
            return do_set(gw, args.pairs)
        return do_restore(gw)
    except Exception as exc:
        print(f"✗ 失败：{type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    # 这台机器的控制台默认是 GBK，而本工具要打印 ✓/✗ 和中文。
    # 不重设的话，一旦被重定向到文件或管道就会 UnicodeEncodeError 崩掉
    # （现象很迷惑：网页明明取到了，却报编码错误，像是网络问题）。
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):    # 老 Python 或已被重定向
            pass
    sys.exit(main())
