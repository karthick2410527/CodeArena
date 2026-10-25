"""VoidRun execution tracer.

Drives LLDB over a C++ binary built with -g -O0, one source line at a time,
and prints the full program state at every stop on stdout using the line
protocol below. It records state; it never reconstructs it. Turning the
per-step states into keyframes and deltas is the Java recorder's job.

Protocol (one record per line, fields separated by TAB, each field escaped
so that it never contains a raw TAB or newline):

    STEP
    K  <key>  <value>          one per entry of the flattened state
    ...
    END  <kind>  <code>  <detail>

kind is one of: exited, crashed, step_limit, time_limit, error.

Flattened state keys. Frames are numbered from the bottom of the stack, so
that main is always f0 and a call pushes a new key prefix instead of
renumbering every frame above it, which keeps deltas small:

    line            innermost user frame's line
    depth           number of user frames on the stack
    out             bytes written to stdout so far
    f<i>.fn         function name of frame i
    f<i>.line       current line of frame i
    f<i>.v.<path>   value of a variable, children as .member or [index]
    f<i>.t.<name>   declared type of a top-level variable

Must stay compatible with the system python3 that LLDB ships for (3.9 on
macOS), so no match statements and no PEP 604 unions.
"""

import argparse
import os
import subprocess
import sys
import threading
import time


def load_lldb():
    # A bare "import lldb" can succeed without giving LLDB: Debian links
    # dist-packages/lldb to a directory that does not exist, which python
    # imports as an empty namespace package. Only a module with SBDebugger
    # counts; otherwise ask the lldb binary where its own module lives.
    lldb = try_import()
    if lldb is not None:
        return lldb
    for exe in ["lldb"] + ["lldb-%d" % v for v in range(22, 13, -1)]:
        try:
            path = subprocess.run([exe, "-P"], capture_output=True, text=True, timeout=10).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            continue
        if path and os.path.isdir(path):
            sys.path.insert(0, path)
            lldb = try_import()
            if lldb is not None:
                return lldb
            sys.path.pop(0)
    raise SystemExit("vr_trace: cannot import the lldb python module")


def try_import():
    sys.modules.pop("lldb", None)
    try:
        import lldb
    except ImportError:
        return None
    if hasattr(lldb, "SBDebugger"):
        return lldb
    sys.modules.pop("lldb", None)
    return None


def esc(s):
    return s.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")


class Tracer(object):
    def __init__(self, lldb, args):
        self.lldb = lldb
        self.args = args
        self.source = os.path.basename(args.source)
        self.out = sys.stdout
        self.steps = 0
        # Per live frame activation: [current line, lines it has finished].
        # A local is shown only once its declaration line, or any line after
        # it, has finished in that activation; before that its stack slot
        # holds garbage. "Any line after" covers declarations without an
        # initialiser (`int n;`), which compile to no code and so are never
        # a line execution stops on.
        self.activations = {}

    # -- output ------------------------------------------------------------

    def emit_state(self, state):
        w = self.out.write
        w("STEP\n")
        for k, v in state:
            w("K\t%s\t%s\n" % (esc(k), esc(v)))
        # Flush per step: if this process is killed, every step written so
        # far must already be with the reader.
        self.out.flush()
        self.steps += 1

    def emit_end(self, kind, code=0, detail=""):
        self.out.write("END\t%s\t%d\t%s\n" % (kind, code, esc(detail)))
        self.out.flush()

    # -- inspection --------------------------------------------------------

    def in_user_code(self, frame):
        le = frame.GetLineEntry()
        if not le.IsValid():
            return False
        line = le.GetLine()
        return 0 < line < 0xFFFFFFFF and le.GetFileSpec().GetFilename() == self.source

    def flatten(self, prefix, value, depth, state, budget):
        if len(state) >= budget:
            return
        vtype = value.GetType()
        summary = value.GetSummary()
        raw = value.GetValue()
        leaf = (
            depth >= self.args.max_value_depth
            or vtype.IsPointerType()
            or (summary is not None and "basic_string" in vtype.GetCanonicalType().GetName())
        )
        n = 0 if leaf else value.GetNumChildren(self.args.max_children + 1)
        if n == 0:
            text = raw if raw is not None else summary
            if raw is not None and summary is not None:
                text = "%s %s" % (raw, summary)
            state.append((prefix, text if text is not None else ""))
            return
        if summary is not None:
            state.append((prefix, summary))
        for i in range(min(n, self.args.max_children)):
            child = value.GetChildAtIndex(i)
            name = child.GetName() or ("[%d]" % i)
            key = prefix + name if name.startswith("[") else prefix + "." + name
            self.flatten(key, child, depth + 1, state, budget)
        if n > self.args.max_children:
            state.append((prefix + "[...]", "truncated"))

    def capture(self, thread):
        lldb = self.lldb
        user_frames = []
        for i in range(thread.GetNumFrames()):
            frame = thread.GetFrameAtIndex(i)
            if self.in_user_code(frame):
                user_frames.append(frame)
        user_frames.reverse()  # bottom of the stack first: main is f0
        depth = len(user_frames)
        state = [
            ("line", str(user_frames[-1].GetLineEntry().GetLine()) if user_frames else "0"),
            ("depth", str(depth)),
            ("out", str(self.stdout_size())),
        ]
        budget = self.args.max_keys
        first = max(0, depth - self.args.max_frames)
        live = {}
        for idx in range(depth):
            frame = user_frames[idx]
            line = frame.GetLineEntry().GetLine()
            fn = frame.GetDisplayFunctionName() or frame.GetFunctionName() or "?"
            key = (idx, frame.GetCFA(), fn)
            act = self.activations.get(key) or [line, set()]
            if act[0] != line:
                act[1].add(act[0])
                act[0] = line
            live[key] = act
            if idx < first:
                continue
            p = "f%d." % idx
            state.append((p + "fn", fn))
            state.append((p + "line", str(line)))
            seen = set()
            variables = [(True, v) for v in frame.GetVariables(True, False, False, True)]
            variables += [(False, v) for v in frame.GetVariables(False, True, False, True)]
            for is_argument, var in variables:
                name = var.GetName()
                if not name or name in seen:
                    continue
                if not is_argument and not self.initialised(var, act[1]):
                    continue
                seen.add(name)
                state.append((p + "t." + name, var.GetTypeName() or ""))
                self.flatten(p + "v." + name, var, 0, state, budget)
        self.activations = live  # drops frames that have returned
        if len(state) >= budget:
            state.append(("[...]", "state truncated"))
        return state

    def initialised(self, var, finished_lines):
        decl = var.GetDeclaration()
        if not decl.IsValid() or decl.GetFileSpec().GetFilename() != self.source:
            return True
        line = decl.GetLine()
        return any(f >= line for f in finished_lines)

    def stdout_size(self):
        try:
            return os.path.getsize(self.args.stdout)
        except OSError:
            return 0

    # -- driving -----------------------------------------------------------

    def run(self):
        lldb = self.lldb
        a = self.args
        debugger = lldb.SBDebugger.Create(False)
        debugger.SetAsync(False)
        # Never step into the standard library; step out of anything else
        # that is not the user's file below.
        debugger.HandleCommand("settings set target.process.thread.step-avoid-regexp ^(std|__gnu_cxx|__cxxabiv1)::")
        # Disabling ASLR needs personality(2), which container seccomp
        # profiles commonly refuse.
        debugger.HandleCommand("settings set target.disable-aslr false")

        target = debugger.CreateTarget(a.binary)
        if not target.IsValid():
            return self.emit_end("error", 0, "cannot load binary")
        bp = target.BreakpointCreateByName("main", target.GetExecutable().GetFilename())

        info = lldb.SBLaunchInfo([])
        # The setting above is only a default; clear the flag on this launch
        # too, or lldb-server still calls personality(2) and the launch fails.
        info.SetLaunchFlags(info.GetLaunchFlags() & ~lldb.eLaunchFlagDisableASLR)
        info.SetWorkingDirectory(os.path.dirname(os.path.abspath(a.binary)))
        info.AddOpenFileAction(0, a.stdin, True, False)
        info.AddOpenFileAction(1, a.stdout, False, True)
        info.AddOpenFileAction(2, a.stderr, False, True)
        error = lldb.SBError()
        process = target.Launch(info, error)
        if not error.Success() or not process.IsValid():
            return self.emit_end("error", 0, "launch failed: %s" % error.GetCString())
        target.BreakpointDelete(bp.GetID())

        deadline = time.monotonic() + a.max_seconds
        # A line that never finishes (while(true){} on one line) blocks inside
        # StepInto, so the loop's own deadline check is never reached. The
        # timer interrupts the process, which makes StepInto return.
        alarm = threading.Timer(a.max_seconds, process.SendAsyncInterrupt)
        alarm.daemon = True
        alarm.start()
        try:
            self.loop(process, deadline)
        finally:
            alarm.cancel()
            if process.GetState() not in (lldb.eStateExited, lldb.eStateDetached):
                process.Kill()
            lldb.SBDebugger.Destroy(debugger)

    def loop(self, process, deadline):
        lldb = self.lldb
        while True:
            st = process.GetState()
            if st == lldb.eStateExited:
                return self.emit_end("exited", process.GetExitStatus(), process.GetExitDescription() or "")
            if st != lldb.eStateStopped:
                return self.emit_end("error", 0, "unexpected process state %d" % st)
            thread = process.GetSelectedThread()
            if time.monotonic() > deadline:
                if self.in_user_code(thread.GetFrameAtIndex(0)):
                    self.emit_state(self.capture(thread))  # where it was stuck
                return self.emit_end("time_limit", 0, "recording exceeded %ss" % self.args.max_seconds)

            reason = thread.GetStopReason()
            if reason in (lldb.eStopReasonSignal, lldb.eStopReasonException):
                self.emit_state(self.capture(thread))
                return self.emit_end("crashed", 0, thread.GetStopDescription(256) or "stopped by signal")

            frame = thread.GetFrameAtIndex(0)
            if self.in_user_code(frame):
                if self.steps >= self.args.max_steps:
                    return self.emit_end("step_limit", 0, "recording stopped after %d steps" % self.steps)
                self.emit_state(self.capture(thread))
                thread.StepInto()
            elif any(self.in_user_code(thread.GetFrameAtIndex(i)) for i in range(1, thread.GetNumFrames())):
                thread.StepOut()  # library code called from user code
            else:
                process.Continue()  # outside main: let it finish


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--binary", required=True)
    p.add_argument("--source", required=True, help="the user's source file; only its lines are recorded")
    p.add_argument("--stdin", required=True)
    p.add_argument("--stdout", required=True)
    p.add_argument("--stderr", default=os.devnull)
    p.add_argument("--max-steps", type=int, default=2000)
    p.add_argument("--max-seconds", type=float, default=20.0)
    p.add_argument("--max-frames", type=int, default=32)
    p.add_argument("--max-children", type=int, default=64)
    p.add_argument("--max-value-depth", type=int, default=3)
    p.add_argument("--max-keys", type=int, default=600)
    args = p.parse_args()
    Tracer(load_lldb(), args).run()


if __name__ == "__main__":
    main()
