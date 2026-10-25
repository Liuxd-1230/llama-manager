import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Modal } from "../../components/kit";

interface Req {
  kind: "confirm" | "prompt";
  title: string;
  message?: string;
  value?: string;
  okText?: string;
  danger?: boolean;
  resolve: (v: any) => void;
}

const useDlg = create<{ req: Req | null }>(() => ({ req: null }));

export function confirmDialog(title: string, message?: string, opts: { okText?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => useDlg.setState({ req: { kind: "confirm", title, message, resolve, ...opts } }));
}

export function promptDialog(title: string, value = "", message?: string): Promise<string | null> {
  return new Promise((resolve) => useDlg.setState({ req: { kind: "prompt", title, value, message, resolve } }));
}

export function DialogHost() {
  const req = useDlg((s) => s.req);
  const [v, setV] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (req?.kind === "prompt") {
      setV(req.value || "");
      setTimeout(() => input.current?.select(), 30);
    }
  }, [req]);
  if (!req) return null;
  const done = (val: any) => {
    useDlg.setState({ req: null });
    req.resolve(val);
  };
  const ok = () => done(req.kind === "confirm" ? true : v.trim() || null);
  return (
    <Modal className="studio-root"
      title={req.title}
      onClose={() => done(req.kind === "confirm" ? false : null)}
      foot={
        <>
          <div className="spacer" />
          <button type="button" className="btn" onClick={() => done(req.kind === "confirm" ? false : null)}>取消</button>
          <button type="button" className={req.danger ? "btn btn-danger" : "btn btn-primary"} onClick={ok} autoFocus={req.kind === "confirm"}>
            {req.okText || "确定"}
          </button>
        </>
      }
    >
      <div style={{ width: 380, maxWidth: "100%" }}>
        {req.message && <p className="hint" style={{ marginTop: 0, fontSize: 12.5, color: "var(--ink-2)" }}>{req.message}</p>}
        {req.kind === "prompt" && (
          <input ref={input} className="input" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok()} />
        )}
      </div>
    </Modal>
  );
}
