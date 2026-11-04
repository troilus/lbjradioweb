#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""字库刷写工具（图形界面版）

把 16×16 / 8×8 中文字库写进多系统固件预留的 flash 尾部空区。
串口协议层直接复用同目录的 font_write.py，这里不复制任何常量。

直接运行：
    python font_write_gui.py

打包成单文件 exe：
    双击 build_exe.bat，或
    pyinstaller --onefile --noconsole --name LBRFontWriter font_write_gui.py
"""

import os
import queue
import sys
import threading
import traceback

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import font_write as fw


APP_TITLE = "字库刷写工具"
KINDS = (16, 8)
STAGE_TEXT = {"erase": "擦除", "write": "写入", "verify": "校验"}


def base_of(kind):
    return fw.FONT16_BASE if kind == 16 else fw.FONT8_BASE


def resource_path(name):
    """打包成 onefile 后，附带文件在 sys._MEIPASS 里。"""
    root = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(root, name)


class FontWriterApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP_TITLE)
        self.minsize(720, 500)

        self.busy = False
        self.worker = None
        self.cancel_event = threading.Event()
        self.messages = queue.Queue()
        self.port_devices = {}
        self.status_var = tk.StringVar(value="就绪")
        self.verify_var = tk.BooleanVar(value=True)
        self.debug_var = tk.BooleanVar(value=False)

        self._build_ui()
        self._load_icon()
        self._place_window()
        self.refresh_ports()
        self.after(60, self._poll)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ------------------------------------------------------------------ 界面

    def _build_ui(self):
        self.columnconfigure(0, weight=1)
        self.rowconfigure(3, weight=1)

        # ---- 串口 ----
        port_box = ttk.LabelFrame(self, text="串口")
        port_box.grid(row=0, column=0, sticky="ew", padx=10, pady=(10, 4))
        port_box.columnconfigure(1, weight=1)

        ttk.Label(port_box, text="端口").grid(row=0, column=0, padx=(10, 4), pady=8)
        self.port_box = ttk.Combobox(port_box, state="readonly", width=34)
        self.port_box.grid(row=0, column=1, sticky="ew", pady=8)
        self.refresh_btn = ttk.Button(port_box, text="刷新", width=8, command=self.refresh_ports)
        self.refresh_btn.grid(row=0, column=2, padx=6, pady=8)

        ttk.Label(port_box, text="波特率").grid(row=0, column=3, padx=(14, 4))
        self.baud_box = ttk.Combobox(port_box, values=["38400", "57600", "115200"],
                                     width=9, state="readonly")
        self.baud_box.set("38400")
        self.baud_box.grid(row=0, column=4, padx=(0, 10))

        # ---- 字库文件 ----
        files = ttk.LabelFrame(self, text="字库文件")
        files.grid(row=1, column=0, sticky="ew", padx=10, pady=4)
        files.columnconfigure(1, weight=1)

        self.font_rows = {}
        for i, kind in enumerate(KINDS):
            r = i * 2
            ttk.Label(files, text=f"{kind}×{kind}").grid(
                row=r, column=0, padx=(10, 6), pady=(10, 0), sticky="w")

            entry = ttk.Entry(files, state="readonly")
            entry.grid(row=r, column=1, sticky="ew", pady=(10, 0))

            browse = ttk.Button(files, text="浏览…", width=8,
                                command=lambda k=kind: self.pick_file(k))
            browse.grid(row=r, column=2, padx=6, pady=(10, 0))

            clear = ttk.Button(files, text="清除", width=6,
                               command=lambda k=kind: self.clear_font(k))
            clear.grid(row=r, column=3, padx=(0, 10), pady=(10, 0))

            info = ttk.Label(files, text=f"目标地址 0x{base_of(kind):06X}　未选择文件",
                             foreground="#6e7781")
            info.grid(row=r + 1, column=1, columnspan=3, sticky="w", pady=(0, 8))

            self.font_rows[kind] = {
                "entry": entry, "browse": browse, "clear": clear,
                "info": info, "path": None, "data": None,
            }

        # ---- 选项 ----
        opts = ttk.Frame(self)
        opts.grid(row=2, column=0, sticky="ew", padx=12, pady=(0, 2))
        self.verify_chk = ttk.Checkbutton(opts, text="写后校验（逐扇区 CRC32 + 抽样回读）",
                                          variable=self.verify_var)
        self.verify_chk.pack(side="left")
        self.debug_chk = ttk.Checkbutton(opts, text="显示调试收发", variable=self.debug_var)
        self.debug_chk.pack(side="left", padx=(18, 0))

        # ---- 进度 + 日志 ----
        body = ttk.Frame(self)
        body.grid(row=3, column=0, sticky="nsew", padx=10, pady=4)
        body.columnconfigure(0, weight=1)
        body.rowconfigure(1, weight=1)

        bar = ttk.Frame(body)
        bar.grid(row=0, column=0, sticky="ew", pady=(0, 6))
        bar.columnconfigure(0, weight=1)
        self.progress = ttk.Progressbar(bar, mode="determinate", maximum=100)
        self.progress.grid(row=0, column=0, sticky="ew")
        ttk.Label(bar, textvariable=self.status_var, width=34,
                  anchor="w").grid(row=0, column=1, padx=(10, 0))

        log_frame = ttk.Frame(body)
        log_frame.grid(row=1, column=0, sticky="nsew")
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)

        self.log_text = tk.Text(log_frame, height=14, wrap="none", font="TkFixedFont",
                                state="disabled", background="#fbfbfc",
                                relief="solid", borderwidth=1)
        self.log_text.grid(row=0, column=0, sticky="nsew")
        scroll = ttk.Scrollbar(log_frame, orient="vertical", command=self.log_text.yview)
        scroll.grid(row=0, column=1, sticky="ns")
        self.log_text.configure(yscrollcommand=scroll.set)
        for tag, color in (("info", "#1f2328"), ("ok", "#1a7f37"),
                           ("warn", "#9a6700"), ("err", "#cf222e"),
                           ("debug", "#6e7781")):
            self.log_text.tag_configure(tag, foreground=color)

        # ---- 按钮 ----
        btns = ttk.Frame(self)
        btns.grid(row=4, column=0, sticky="e", padx=10, pady=(2, 10))
        self.cancel_btn = ttk.Button(btns, text="取消", width=10,
                                     command=self._cancel, state="disabled")
        self.cancel_btn.pack(side="right", padx=(8, 0))
        self.start_btn = ttk.Button(btns, text="开始刷写", width=12,
                                    command=self._start, state="disabled")
        self.start_btn.pack(side="right")

        self._log("刷字库前请先关闭 UV Studio / K5Viewer，电台正常开机，不要进 DFU。", "info")

    def _place_window(self):
        """按屏幕大小自适应，小屏（1366×768）上也能看到底部按钮。"""
        self.update_idletasks()
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        w = min(880, max(720, sw - 160))
        h = min(640, max(500, sh - 150))
        x = max(0, (sw - w) // 2)
        y = max(0, (sh - h) // 2 - 24)
        self.geometry(f"{w}x{h}+{x}+{y}")

    def _load_icon(self):
        for name in ("LBRFontWriter.ico", "font_writer.ico"):
            path = resource_path(name)
            if os.path.isfile(path):
                try:
                    self.iconbitmap(path)
                    return
                except tk.TclError:
                    pass

    # ------------------------------------------------------------ 串口枚举

    def refresh_ports(self):
        try:
            from serial.tools import list_ports
        except ImportError:
            self.port_box["values"] = ()
            self._log("没有安装 pyserial，无法枚举串口。请先运行：pip install pyserial", "err")
            return

        current = self.port_box.get()
        ports = list(list_ports.comports())
        self.port_devices = {}
        labels = []
        for p in ports:
            desc = (p.description or "").strip()
            label = f"{p.device} — {desc}" if desc and desc.lower() != "n/a" else p.device
            labels.append(label)
            self.port_devices[label] = p.device

        self.port_box["values"] = labels
        if current in labels:
            self.port_box.set(current)
        elif labels:
            self.port_box.current(0)
        else:
            self.port_box.set("")
            self._log("没找到串口。插好写频线后点「刷新」。", "warn")

    def _selected_port(self):
        return self.port_devices.get(self.port_box.get(), "")

    # ------------------------------------------------------------ 选文件

    def pick_file(self, kind):
        row = self.font_rows[kind]
        initial = os.path.dirname(row["path"]) if row["path"] else os.getcwd()
        path = filedialog.askopenfilename(
            parent=self,
            title=f"选择 {kind}×{kind} 字库文件",
            initialdir=initial,
            filetypes=[("字库文件", "*.fon"), ("所有文件", "*.*")],
        )
        if path:
            self.load_font_file(kind, path)

    def load_font_file(self, kind, path):
        try:
            name, blob, note = fw.load_font(path)
        except SystemExit as e:
            messagebox.showerror(APP_TITLE, str(e.code or "无法读取该文件。"))
            return

        actual = 16 if name.startswith("16") else 8
        self._apply_font(actual, path, name, blob, note)
        if actual != kind:
            self._log(f"{os.path.basename(path)} 是 {name} 字库，已自动放到 "
                      f"{actual}×{actual} 一栏。", "warn")

    def _apply_font(self, kind, path, name, blob, note):
        row = self.font_rows[kind]
        row["path"] = path
        row["data"] = {"path": path, "name": name, "blob": blob, "note": note}

        row["entry"].configure(state="normal")
        row["entry"].delete(0, "end")
        row["entry"].insert(0, path)
        row["entry"].configure(state="readonly")

        text = f"{fw.human(len(blob))} 字节　→　0x{base_of(kind):06X}"
        if note:
            text += f"　{note}"
        row["info"].configure(text=text, foreground="#1a7f37")
        self._log(f"已选择 {name} 字库：{os.path.basename(path)}"
                  f"（{fw.human(len(blob))} 字节）", "info")
        self._update_buttons()

    def clear_font(self, kind):
        row = self.font_rows[kind]
        row["path"] = None
        row["data"] = None
        row["entry"].configure(state="normal")
        row["entry"].delete(0, "end")
        row["entry"].configure(state="readonly")
        row["info"].configure(
            text=f"目标地址 0x{base_of(kind):06X}　未选择文件", foreground="#6e7781")
        self._update_buttons()

    def _collect_jobs(self):
        jobs = []
        for kind in KINDS:
            data = self.font_rows[kind]["data"]
            if data:
                jobs.append((data["name"], data["path"], base_of(kind),
                             data["blob"], data["note"]))
        return jobs

    # ------------------------------------------------------------ 开始 / 取消

    def _start(self):
        jobs = self._collect_jobs()
        if not jobs:
            messagebox.showwarning(APP_TITLE, "请先选择至少一个字库文件。")
            return
        port = self._selected_port()
        if not port:
            messagebox.showwarning(APP_TITLE, "请选择串口。没插写频线？点「刷新」重试。")
            return

        detail = "\n".join(
            f"  {name}　{os.path.basename(path)}\n"
            f"      → 0x{base:06X}（{fw.human(len(blob))} 字节）"
            for name, path, base, blob, _ in jobs
        )
        if not messagebox.askyesno(
                APP_TITLE,
                f"将要写入：\n\n{detail}\n\n"
                "写的时候不要断电、不要拔线。\n"
                "写错只会影响字库，不影响固件本身。\n\n现在开始？"):
            return

        self._clear_log()
        self.progress["value"] = 0
        self.status_var.set("连接中…")
        self._set_busy(True)
        self.cancel_event.clear()

        self.worker = threading.Thread(
            target=self._worker,
            args=(jobs, port, int(self.baud_box.get()),
                  self.verify_var.get(), self.debug_var.get()),
            daemon=True,
        )
        self.worker.start()

    def _cancel(self):
        if not self.busy:
            return
        self.cancel_event.set()
        self.cancel_btn.configure(state="disabled")
        self.status_var.set("正在取消…")
        self._log("已请求取消，等当前这条命令回完就停。", "warn")

    # ------------------------------------------------------------ 后台线程

    def _worker(self, jobs, port, baud, verify, debug):
        dev = None
        try:
            dev = fw.Device(port, baud, debug=debug,
                            debug_log=lambda s: self.messages.put(("log", s, "debug")))
            version = dev.handshake()
            self.messages.put((
                "log",
                f"已连接：固件 {version or '(未知版本)'}（timestamp 0x{dev.timestamp:08X}）",
                "ok"))

            total = sum(len(job[3]) for job in jobs) or 1
            done_bytes = 0
            for name, path, base, blob, note in jobs:
                size = len(blob)
                start = done_bytes

                def progress(stage, done, count, start=start, size=size):
                    if stage == "erase":
                        inner = 0.10 * done / max(count, 1)
                    elif stage == "write":
                        inner = 0.10 + 0.75 * done / max(count, 1)
                    else:
                        inner = 0.85 + 0.15 * done / max(count, 1)
                    overall = (start + inner * size) / total
                    self.messages.put(("progress", overall, stage, done, count))

                fw.write_font(
                    dev, name, path, base, blob,
                    verify=verify,
                    log=lambda s: self.messages.put(("log", s, "info")),
                    progress=progress,
                    cancel=self.cancel_event.is_set,
                )
                done_bytes += size

            self.messages.put(("done", True, "全部完成。关机再开机，中文就应该正常了。", "ok"))

        except fw.Cancelled:
            self.messages.put(("done", False,
                               "已取消。字库可能只写了一部分，重新刷一遍即可。", "warn"))
        except SystemExit as e:
            self.messages.put(("done", False, str(e.code or "已中止。"), "err"))
        except Exception as e:  # noqa: BLE001 - 界面上要把所有异常都变成提示
            if type(e).__name__ == "SerialException":
                text = (f"串口错误：{e}\n\n"
                        "请确认写频线已插好，且 UV Studio / K5Viewer 没有占用这个串口。")
            elif isinstance(e, OSError):
                text = f"失败：{e}"
            else:
                self.messages.put(("log", traceback.format_exc(), "debug"))
                text = f"{type(e).__name__}: {e}"
            self.messages.put(("done", False, text, "err"))
        finally:
            if dev is not None:
                dev.close()

    # ------------------------------------------------------------ 主线程刷新

    def _poll(self):
        try:
            while True:
                self._handle(self.messages.get_nowait())
        except queue.Empty:
            pass
        self.after(60, self._poll)

    def _handle(self, msg):
        kind = msg[0]

        if kind == "log":
            self._log(msg[1], msg[2])

        elif kind == "progress":
            _, overall, stage, done, count = msg
            overall = max(0.0, min(1.0, overall))
            self.progress["value"] = overall * 100
            if stage == "write":
                detail = f"{fw.human(done)} / {fw.human(count)} 字节"
            else:
                detail = f"{done} / {count}"
            self.status_var.set(f"{STAGE_TEXT.get(stage, stage)} {int(overall * 100)}%　{detail}")

        elif kind == "done":
            _, ok, text, tag = msg
            self._log(text, tag)
            if ok:
                self.progress["value"] = 100
                self.status_var.set("完成")
            else:
                self.status_var.set("已停止")
            self._set_busy(False)
            if ok:
                messagebox.showinfo(APP_TITLE, text)
            elif tag == "warn":
                messagebox.showwarning(APP_TITLE, text)
            else:
                messagebox.showerror(APP_TITLE, text)

    def _log(self, text, tag="info"):
        self.log_text.configure(state="normal")
        self.log_text.insert("end", text.rstrip("\n") + "\n", tag)
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _clear_log(self):
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.configure(state="disabled")

    # ------------------------------------------------------------ 状态

    def _set_busy(self, busy):
        self.busy = busy
        for widget in (self.refresh_btn, self.verify_chk, self.debug_chk):
            widget.configure(state="disabled" if busy else "normal")
        for widget in (self.port_box, self.baud_box):
            widget.configure(state="disabled" if busy else "readonly")
        for kind in KINDS:
            row = self.font_rows[kind]
            for key in ("browse", "clear"):
                row[key].configure(state="disabled" if busy else "normal")
        self.cancel_btn.configure(state="normal" if busy else "disabled")
        self._update_buttons()

    def _update_buttons(self):
        has_font = any(self.font_rows[k]["data"] for k in KINDS)
        self.start_btn.configure(
            state="normal" if (has_font and not self.busy) else "disabled")

    def _on_close(self):
        if self.busy:
            if not messagebox.askyesno(
                    APP_TITLE,
                    "正在写入，确定中止并退出吗？\n"
                    "字库可能只写了一部分，重新刷一遍即可。"):
                return
            self.cancel_event.set()
            if self.worker is not None:
                self.worker.join(timeout=3.0)
        self.destroy()


def enable_dpi_awareness():
    """4K 屏下别让界面糊成一团。"""
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass


def main():
    enable_dpi_awareness()
    app = FontWriterApp()
    app.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
