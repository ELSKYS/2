# -*- coding: utf-8 -*-
"""
RED DMA Bot Manager — desktop GUI to edit products, firmware status, settings.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, simpledialog, ttk

try:
    import customtkinter as ctk

    USE_CTK = True
except ImportError:
    USE_CTK = False


def app_base_dir() -> Path:
    """Bot project root (contains data/, index.js)."""
    if getattr(sys, "frozen", False):
        # EXE next to project, or inside manager/dist — look around
        exe_dir = Path(sys.executable).resolve().parent
        candidates = [
            exe_dir,
            exe_dir.parent,
            exe_dir / "bot",
            Path.cwd(),
        ]
        for c in candidates:
            if (c / "data" / "products.json").exists() or (c / "index.js").exists():
                return c
        return exe_dir
    # Source: .../2/manager/app.py -> .../2
    return Path(__file__).resolve().parent.parent


BASE = app_base_dir()
DATA = BASE / "data"
PRODUCTS_FILE = DATA / "products.json"
FIRMWARE_FILE = DATA / "firmware_status.json"
SETTINGS_FILE = DATA / "settings.json"
ENV_FILE = BASE / ".env"
ENV_EXAMPLE = BASE / ".env.example"


def ensure_data_dir():
    DATA.mkdir(parents=True, exist_ok=True)
    if not PRODUCTS_FILE.exists():
        PRODUCTS_FILE.write_text("[]", encoding="utf-8")
    if not FIRMWARE_FILE.exists():
        FIRMWARE_FILE.write_text("[]", encoding="utf-8")
    if not SETTINGS_FILE.exists():
        SETTINGS_FILE.write_text(
            json.dumps(
                {
                    "brand_name": "RED DMA",
                    "brand_tagline": "Premium DMA Firmware",
                    "website": "https://reddma.xyz",
                    "status_dm_discount": "10%",
                    "status_timezone": "UTC",
                    "status_post_times": ["12:00"],
                    "status_message_ttl_minutes": 10,
                    "ticket_welcome_text": "Welcome! Your order has been created. A staff member will assist you shortly.",
                    "order_instructions": "A staff member will contact you with the next steps for this order.",
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class BotManagerApp:
    def __init__(self):
        ensure_data_dir()
        if USE_CTK:
            ctk.set_appearance_mode("dark")
            ctk.set_default_color_theme("dark-blue")
            self.root = ctk.CTk()
        else:
            self.root = tk.Tk()
        self.root.title("RED DMA Bot Manager")
        self.root.geometry("1100x720")
        self.root.minsize(900, 600)

        self.products = load_json(PRODUCTS_FILE, [])
        self.firmware = load_json(FIRMWARE_FILE, [])
        self.settings = load_json(SETTINGS_FILE, {})

        self._build_ui()
        self.refresh_product_list()
        self.refresh_firmware_list()
        self.load_settings_form()
        self.load_env_form()

    def _frame(self, parent, **kw):
        if USE_CTK:
            return ctk.CTkFrame(parent, **kw)
        return ttk.Frame(parent, **kw)

    def _label(self, parent, text, **kw):
        if USE_CTK:
            return ctk.CTkLabel(parent, text=text, **kw)
        return ttk.Label(parent, text=text, **kw)

    def _button(self, parent, text, command, **kw):
        if USE_CTK:
            return ctk.CTkButton(parent, text=text, command=command, **kw)
        return ttk.Button(parent, text=text, command=command, **kw)

    def _entry(self, parent, **kw):
        if USE_CTK:
            return ctk.CTkEntry(parent, **kw)
        return ttk.Entry(parent, **kw)

    def _textbox(self, parent, **kw):
        if USE_CTK:
            return ctk.CTkTextbox(parent, **kw)
        return tk.Text(parent, **kw)

    def _build_ui(self):
        top = self._frame(self.root)
        top.pack(fill="x", padx=12, pady=8)
        self._label(
            top,
            text=f"项目目录: {BASE}",
        ).pack(side="left")
        self._button(top, text="打开项目文件夹", command=self.open_base_folder).pack(
            side="right", padx=4
        )
        self._button(top, text="重新加载全部", command=self.reload_all).pack(side="right", padx=4)

        if USE_CTK:
            self.tabs = ctk.CTkTabview(self.root)
        else:
            self.tabs = ttk.Notebook(self.root)
        self.tabs.pack(fill="both", expand=True, padx=12, pady=8)

        if USE_CTK:
            self.tab_products = self.tabs.add("产品 Products")
            self.tab_firmware = self.tabs.add("固件状态 Status")
            self.tab_settings = self.tabs.add("文案/设置 Settings")
            self.tab_env = self.tabs.add("环境变量 .env")
            self.tab_deploy = self.tabs.add("部署 Deploy")
        else:
            self.tab_products = ttk.Frame(self.tabs)
            self.tab_firmware = ttk.Frame(self.tabs)
            self.tab_settings = ttk.Frame(self.tabs)
            self.tab_env = ttk.Frame(self.tabs)
            self.tab_deploy = ttk.Frame(self.tabs)
            self.tabs.add(self.tab_products, text="产品")
            self.tabs.add(self.tab_firmware, text="固件状态")
            self.tabs.add(self.tab_settings, text="设置")
            self.tabs.add(self.tab_env, text=".env")
            self.tabs.add(self.tab_deploy, text="部署")

        self._build_products_tab()
        self._build_firmware_tab()
        self._build_settings_tab()
        self._build_env_tab()
        self._build_deploy_tab()

        bottom = self._frame(self.root)
        bottom.pack(fill="x", padx=12, pady=8)
        self.status_var = tk.StringVar(value="就绪 — 虚拟货币地址已从机器人中移除，请勿再写入钱包地址。")
        self._label(bottom, textvariable=self.status_var).pack(side="left")

    # ---------- Products ----------
    def _build_products_tab(self):
        left = self._frame(self.tab_products)
        left.pack(side="left", fill="y", padx=8, pady=8)
        self.product_list = tk.Listbox(left, width=42, height=28, exportselection=False)
        self.product_list.pack(fill="y", expand=True)
        self.product_list.bind("<<ListboxSelect>>", self.on_product_select)

        btns = self._frame(left)
        btns.pack(fill="x", pady=6)
        self._button(btns, text="新增", command=self.add_product).pack(side="left", padx=2)
        self._button(btns, text="删除", command=self.delete_product).pack(side="left", padx=2)
        self._button(btns, text="上移", command=lambda: self.move_product(-1)).pack(
            side="left", padx=2
        )
        self._button(btns, text="下移", command=lambda: self.move_product(1)).pack(
            side="left", padx=2
        )

        right = self._frame(self.tab_products)
        right.pack(side="left", fill="both", expand=True, padx=8, pady=8)

        form = self._frame(right)
        form.pack(fill="x")
        self.prod_fields = {}
        for i, (key, label) in enumerate(
            [
                ("id", "ID (数字)"),
                ("name", "名称"),
                ("price", "价格"),
                ("desc", "简介"),
            ]
        ):
            self._label(form, text=label).grid(row=i, column=0, sticky="w", pady=4)
            e = self._entry(form, width=60)
            e.grid(row=i, column=1, sticky="ew", pady=4, padx=6)
            self.prod_fields[key] = e
        form.columnconfigure(1, weight=1)

        self._label(right, text="特性列表 (每行一条)").pack(anchor="w", pady=(8, 2))
        self.prod_features = self._textbox(right, height=14)
        self.prod_features.pack(fill="both", expand=True)

        self._button(right, text="保存当前产品到列表", command=self.apply_product_form).pack(
            anchor="e", pady=6
        )
        save_kw = {"fg_color": "#16a34a"} if USE_CTK else {}
        self._button(
            right, text="保存全部产品到 products.json", command=self.save_products, **save_kw
        ).pack(anchor="e", pady=4)

    def refresh_product_list(self):
        self.product_list.delete(0, tk.END)
        for p in self.products:
            self.product_list.insert(
                tk.END, f"[{p.get('id')}] {p.get('name', '')} — {p.get('price', '')}"
            )

    def on_product_select(self, _evt=None):
        sel = self.product_list.curselection()
        if not sel:
            return
        p = self.products[sel[0]]
        for k, e in self.prod_fields.items():
            e.delete(0, tk.END)
            e.insert(0, str(p.get(k, "")))
        self._set_text(self.prod_features, "\n".join(p.get("features") or []))

    def _set_text(self, widget, text: str):
        if USE_CTK and hasattr(widget, "delete"):
            widget.delete("1.0", "end")
            widget.insert("1.0", text)
        else:
            widget.delete("1.0", tk.END)
            widget.insert("1.0", text)

    def _get_text(self, widget) -> str:
        if USE_CTK and hasattr(widget, "get"):
            return widget.get("1.0", "end").strip()
        return widget.get("1.0", tk.END).strip()

    def apply_product_form(self):
        sel = self.product_list.curselection()
        try:
            pid = int(self.prod_fields["id"].get().strip())
        except ValueError:
            messagebox.showerror("错误", "ID 必须是数字")
            return
        features = [ln.strip() for ln in self._get_text(self.prod_features).splitlines() if ln.strip()]
        item = {
            "id": pid,
            "name": self.prod_fields["name"].get().strip(),
            "price": self.prod_fields["price"].get().strip(),
            "desc": self.prod_fields["desc"].get().strip(),
            "features": features,
        }
        if not item["name"]:
            messagebox.showerror("错误", "名称不能为空")
            return
        if sel:
            self.products[sel[0]] = item
        else:
            self.products.append(item)
        self.refresh_product_list()
        self.status_var.set(f"已更新产品: {item['name']}（记得点保存到文件）")

    def add_product(self):
        next_id = max([p.get("id", 0) for p in self.products], default=-1) + 1
        self.products.append(
            {
                "id": next_id,
                "name": f"New Product {next_id}",
                "price": "$0",
                "desc": "Description",
                "features": ["Feature 1"],
            }
        )
        self.refresh_product_list()
        self.product_list.selection_clear(0, tk.END)
        self.product_list.selection_set(tk.END)
        self.product_list.see(tk.END)
        self.on_product_select()

    def delete_product(self):
        sel = self.product_list.curselection()
        if not sel:
            return
        if messagebox.askyesno("确认", "删除选中产品？"):
            del self.products[sel[0]]
            self.refresh_product_list()

    def move_product(self, delta: int):
        sel = self.product_list.curselection()
        if not sel:
            return
        i = sel[0]
        j = i + delta
        if j < 0 or j >= len(self.products):
            return
        self.products[i], self.products[j] = self.products[j], self.products[i]
        self.refresh_product_list()
        self.product_list.selection_set(j)

    def save_products(self):
        # re-index check duplicate ids
        ids = [p.get("id") for p in self.products]
        if len(ids) != len(set(ids)):
            messagebox.showerror("错误", "存在重复的产品 ID，请先修正")
            return
        save_json(PRODUCTS_FILE, self.products)
        self.status_var.set(f"已保存 {len(self.products)} 个产品 → {PRODUCTS_FILE}")
        messagebox.showinfo("成功", f"已写入\n{PRODUCTS_FILE}\n\n部署到 Railway 后机器人会加载新数据。")

    # ---------- Firmware ----------
    def _build_firmware_tab(self):
        left = self._frame(self.tab_firmware)
        left.pack(side="left", fill="y", padx=8, pady=8)
        self.fw_list = tk.Listbox(left, width=48, height=28, exportselection=False)
        self.fw_list.pack(fill="y", expand=True)
        self.fw_list.bind("<<ListboxSelect>>", self.on_fw_select)
        row = self._frame(left)
        row.pack(fill="x", pady=6)
        self._button(row, text="新增", command=self.add_fw).pack(side="left", padx=2)
        self._button(row, text="删除", command=self.delete_fw).pack(side="left", padx=2)

        right = self._frame(self.tab_firmware)
        right.pack(side="left", fill="both", expand=True, padx=8, pady=8)
        self._label(right, text="名称").pack(anchor="w")
        self.fw_name = self._entry(right, width=50)
        self.fw_name.pack(fill="x", pady=4)
        self._label(right, text="备注 note").pack(anchor="w")
        self.fw_note = self._entry(right, width=50)
        self.fw_note.pack(fill="x", pady=4)
        self._button(right, text="应用修改", command=self.apply_fw).pack(anchor="e", pady=8)
        self._button(right, text="保存 firmware_status.json", command=self.save_firmware).pack(
            anchor="e"
        )

    def refresh_firmware_list(self):
        self.fw_list.delete(0, tk.END)
        for item in self.firmware:
            self.fw_list.insert(tk.END, f"{item.get('name', '')} — {item.get('note', '')}")

    def on_fw_select(self, _evt=None):
        sel = self.fw_list.curselection()
        if not sel:
            return
        item = self.firmware[sel[0]]
        self.fw_name.delete(0, tk.END)
        self.fw_name.insert(0, item.get("name", ""))
        self.fw_note.delete(0, tk.END)
        self.fw_note.insert(0, item.get("note", ""))

    def apply_fw(self):
        sel = self.fw_list.curselection()
        item = {"name": self.fw_name.get().strip(), "note": self.fw_note.get().strip()}
        if not item["name"]:
            messagebox.showerror("错误", "名称不能为空")
            return
        if sel:
            self.firmware[sel[0]] = item
        else:
            self.firmware.append(item)
        self.refresh_firmware_list()

    def add_fw(self):
        self.firmware.append({"name": "New Firmware", "note": "OK"})
        self.refresh_firmware_list()
        self.fw_list.selection_set(tk.END)
        self.on_fw_select()

    def delete_fw(self):
        sel = self.fw_list.curselection()
        if not sel:
            return
        del self.firmware[sel[0]]
        self.refresh_firmware_list()

    def save_firmware(self):
        save_json(FIRMWARE_FILE, self.firmware)
        self.status_var.set(f"已保存固件状态 → {FIRMWARE_FILE}")
        messagebox.showinfo("成功", f"已写入\n{FIRMWARE_FILE}")

    # ---------- Settings ----------
    def _build_settings_tab(self):
        wrap = self._frame(self.tab_settings)
        wrap.pack(fill="both", expand=True, padx=12, pady=12)
        self.set_fields = {}
        keys = [
            ("brand_name", "品牌名"),
            ("brand_tagline", "副标题"),
            ("website", "网站"),
            ("status_dm_discount", "私信折扣文案"),
            ("status_timezone", "状态时区 IANA"),
            ("status_post_times", "发帖时间(逗号分隔 HH:mm)"),
            ("status_message_ttl_minutes", "@everyone 保留分钟数"),
            ("ticket_welcome_text", "工单欢迎语"),
            ("order_instructions", "订单说明(无加密货币地址)"),
        ]
        for i, (key, label) in enumerate(keys):
            self._label(wrap, text=label).grid(row=i, column=0, sticky="nw", pady=6)
            if key in ("ticket_welcome_text", "order_instructions"):
                e = self._textbox(wrap, height=4, width=70)
                e.grid(row=i, column=1, sticky="ew", pady=6, padx=8)
            else:
                e = self._entry(wrap, width=70)
                e.grid(row=i, column=1, sticky="ew", pady=6, padx=8)
            self.set_fields[key] = e
        wrap.columnconfigure(1, weight=1)
        self._button(wrap, text="保存 settings.json", command=self.save_settings).grid(
            row=len(keys), column=1, sticky="e", pady=12
        )
        note = self._label(
            wrap,
            text="注意：不要在任何字段里填写虚拟货币钱包地址。机器人已移除自动发送地址功能。",
        )
        note.grid(row=len(keys) + 1, column=0, columnspan=2, sticky="w")

    def load_settings_form(self):
        s = self.settings
        mapping = {
            "brand_name": s.get("brand_name", ""),
            "brand_tagline": s.get("brand_tagline", ""),
            "website": s.get("website", ""),
            "status_dm_discount": s.get("status_dm_discount", "10%"),
            "status_timezone": s.get("status_timezone", "UTC"),
            "status_post_times": ",".join(s.get("status_post_times") or ["12:00"]),
            "status_message_ttl_minutes": str(s.get("status_message_ttl_minutes", 10)),
            "ticket_welcome_text": s.get("ticket_welcome_text", ""),
            "order_instructions": s.get("order_instructions", ""),
        }
        for k, v in mapping.items():
            w = self.set_fields[k]
            if USE_CTK and k in ("ticket_welcome_text", "order_instructions"):
                self._set_text(w, v)
            elif k in ("ticket_welcome_text", "order_instructions"):
                self._set_text(w, v)
            else:
                w.delete(0, tk.END)
                w.insert(0, v)

    def save_settings(self):
        times = [
            t.strip()
            for t in self.set_fields["status_post_times"].get().split(",")
            if t.strip()
        ]
        try:
            ttl = int(self.set_fields["status_message_ttl_minutes"].get().strip() or "10")
        except ValueError:
            messagebox.showerror("错误", "TTL 必须是整数分钟")
            return
        data = {
            "brand_name": self.set_fields["brand_name"].get().strip(),
            "brand_tagline": self.set_fields["brand_tagline"].get().strip(),
            "website": self.set_fields["website"].get().strip(),
            "status_dm_discount": self.set_fields["status_dm_discount"].get().strip(),
            "status_timezone": self.set_fields["status_timezone"].get().strip() or "UTC",
            "status_post_times": times or ["12:00"],
            "status_message_ttl_minutes": ttl,
            "ticket_welcome_text": self._get_text(self.set_fields["ticket_welcome_text"]),
            "order_instructions": self._get_text(self.set_fields["order_instructions"]),
        }
        # Guard: refuse obvious wallet strings
        blob = json.dumps(data, ensure_ascii=False).lower()
        banned = ["ltc1", "bc1", "0x", "solana", "bitcoin", "litecoin"]
        # loose check for crypto address patterns is hard; just warn on keywords
        for b in ("ltc1", "bitcoin", "litecoin", "wallet address"):
            if b in blob:
                if not messagebox.askyesno(
                    "警告",
                    f"设置里疑似包含加密货币相关内容（{b}）。\n仍要保存吗？推荐删除后再存。",
                ):
                    return
                break
        self.settings = data
        save_json(SETTINGS_FILE, data)
        self.status_var.set(f"已保存设置 → {SETTINGS_FILE}")
        messagebox.showinfo("成功", f"已写入\n{SETTINGS_FILE}")

    # ---------- Env ----------
    def _build_env_tab(self):
        wrap = self._frame(self.tab_env)
        wrap.pack(fill="both", expand=True, padx=12, pady=12)
        self._label(
            wrap,
            text="本地 .env（仅本机调试用）。Railway 上请在控制台 Variables 配置。不要提交到 Git。",
        ).pack(anchor="w")
        self.env_text = self._textbox(wrap, height=24)
        self.env_text.pack(fill="both", expand=True, pady=8)
        row = self._frame(wrap)
        row.pack(fill="x")
        self._button(row, text="从 .env.example 加载模板", command=self.load_env_example).pack(
            side="left", padx=4
        )
        self._button(row, text="保存 .env", command=self.save_env).pack(side="right", padx=4)

    def load_env_form(self):
        if ENV_FILE.exists():
            self._set_text(self.env_text, ENV_FILE.read_text(encoding="utf-8", errors="replace"))
        elif ENV_EXAMPLE.exists():
            self._set_text(self.env_text, ENV_EXAMPLE.read_text(encoding="utf-8", errors="replace"))
        else:
            self._set_text(
                self.env_text,
                "TOKEN=\nCLIENT_ID=\nTICKET_CATEGORY_ID=\nSTAFF_ROLE_ID=\nSTATUS_CHANNEL_ID=\n",
            )

    def load_env_example(self):
        if ENV_EXAMPLE.exists():
            self._set_text(self.env_text, ENV_EXAMPLE.read_text(encoding="utf-8", errors="replace"))

    def save_env(self):
        text = self._get_text(self.env_text) + "\n"
        ENV_FILE.write_text(text, encoding="utf-8")
        self.status_var.set(f"已保存 {ENV_FILE}")
        messagebox.showinfo("成功", f"已保存本地 .env\n{ENV_FILE}")

    # ---------- Deploy ----------
    def _build_deploy_tab(self):
        wrap = self._frame(self.tab_deploy)
        wrap.pack(fill="both", expand=True, padx=16, pady=16)
        help_text = (
            "发布流程建议：\n"
            "1. 在「产品 / 固件 / 设置」页改完并保存 JSON\n"
            "2. 点下方「Git 提交并推送」把变更推到 GitHub (ELSKYS/2)\n"
            "3. Railway 已连接该仓库时会自动重新部署\n"
            "4. 线上机器人重启后读取 data/*.json；也可用 Discord /reload-data（管理员）\n\n"
            "本地调试：先配置 .env，再「本地启动机器人」。\n"
            "虚拟货币地址已从代码中删除，请勿再添加。"
        )
        self._label(wrap, text=help_text, justify="left").pack(anchor="w", pady=8)
        row = self._frame(wrap)
        row.pack(fill="x", pady=12)
        self._button(row, text="本地启动机器人 npm start", command=self.start_bot_local).pack(
            side="left", padx=6
        )
        self._button(row, text="打开 GitHub 仓库", command=self.open_github).pack(
            side="left", padx=6
        )
        self._button(row, text="Git 提交并推送", command=self.git_commit_push).pack(
            side="left", padx=6
        )
        self.log = self._textbox(wrap, height=16)
        self.log.pack(fill="both", expand=True, pady=8)

    def _append_log(self, text: str):
        cur = self._get_text(self.log)
        self._set_text(self.log, (cur + "\n" + text).strip())

    def open_base_folder(self):
        os.startfile(str(BASE))

    def open_github(self):
        os.startfile("https://github.com/ELSKYS/2")

    def reload_all(self):
        self.products = load_json(PRODUCTS_FILE, [])
        self.firmware = load_json(FIRMWARE_FILE, [])
        self.settings = load_json(SETTINGS_FILE, {})
        self.refresh_product_list()
        self.refresh_firmware_list()
        self.load_settings_form()
        self.load_env_form()
        self.status_var.set("已从磁盘重新加载")

    def start_bot_local(self):
        try:
            if not (BASE / "node_modules").exists():
                self._append_log("正在 npm install ...")
                subprocess.run(
                    ["npm", "install"],
                    cwd=str(BASE),
                    check=True,
                    shell=True,
                    capture_output=True,
                    text=True,
                )
            subprocess.Popen(
                ["npm", "start"],
                cwd=str(BASE),
                shell=True,
                creationflags=subprocess.CREATE_NEW_CONSOLE if os.name == "nt" else 0,
            )
            self._append_log("已在新窗口启动 npm start")
            self.status_var.set("本地机器人已启动（新窗口）")
        except Exception as e:
            messagebox.showerror("启动失败", str(e))
            self._append_log(f"启动失败: {e}")

    def git_commit_push(self):
        msg = simpledialog.askstring(
            "提交说明",
            "Commit message:",
            initialvalue="chore: update bot data via manager",
        )
        if not msg:
            return
        cmds = [
            ["git", "add", "data", "index.js", ".env.example", "manager", "package.json"],
            ["git", "status", "--short"],
            ["git", "commit", "-m", msg],
            ["git", "push", "origin", "main"],
        ]
        env = os.environ.copy()
        # Prefer proxy if set by user system
        try:
            for cmd in cmds:
                self._append_log("> " + " ".join(cmd))
                r = subprocess.run(
                    cmd,
                    cwd=str(BASE),
                    capture_output=True,
                    text=True,
                    env=env,
                )
                out = (r.stdout or "") + (r.stderr or "")
                self._append_log(out.strip() or f"(exit {r.returncode})")
                if r.returncode != 0 and cmd[1] != "commit":
                    # commit may fail if nothing to commit
                    if "nothing to commit" in out.lower():
                        continue
                    if cmd[1] == "commit" and r.returncode != 0:
                        continue
                    messagebox.showerror("Git 失败", out or f"exit {r.returncode}")
                    return
            self.status_var.set("已推送到 GitHub（若 Railway 自动部署则会更新线上 Bot）")
            messagebox.showinfo("完成", "推送完成。请到 Railway 确认部署状态。")
        except Exception as e:
            messagebox.showerror("错误", str(e))

    def run(self):
        self.root.mainloop()


def main():
    BotManagerApp().run()


if __name__ == "__main__":
    main()
