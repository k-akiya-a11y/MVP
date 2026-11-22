import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryJson, ReviewItem, ReviewQueue } from "@/lib/review/queue";

// 実際の ReviewBoard のハンドラを、最小の hook 実装（useState / useRef / useMemo / useCallback / useEffect）で動かす。
// 再描画は render() を呼んだときだけ起きる。呼ぶ前のハンドラは「再描画前に届いた古いハンドラ」を表す。
// useEffect は依存配列が変わったときだけ、前回のクリーンアップを呼んでから実行する。
// DOM・ブラウザは通らない（合成テスト）。
const h = vi.hoisted(() => {
  type Slot = { value?: unknown; current?: unknown; memo?: unknown; deps?: readonly unknown[]; cleanup?: unknown };
  const st = {
    slots: [] as Slot[],
    index: 0,
    dirty: false,
    pending: [] as { i: number; fn: () => unknown; deps?: readonly unknown[] }[],
    listeners: new Set<(e: unknown) => void>(),
    events: [] as string[],
    review: vi.fn(),
    bulk: vi.fn(),
  };
  const changed = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !a || !b || a.length !== b.length || a.some((x, k) => !Object.is(x, b[k]));
  return { st, changed };
});

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  const { st, changed } = h;
  const take = () => {
    const i = st.index++;
    return { i, s: (st.slots[i] ??= {}) };
  };
  return {
    ...actual,
    useState: <T>(init: T) => {
      const { s } = take();
      if (!("value" in s)) s.value = init;
      const set = (v: T | ((p: T) => T)) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(s.value as T) : v;
        if (!Object.is(next, s.value)) {
          s.value = next;
          st.dirty = true;
        }
      };
      return [s.value as T, set] as const;
    },
    useRef: <T>(init: T) => {
      const { s } = take();
      if (!("current" in s)) s.current = init;
      return s as { current: T };
    },
    useMemo: <T>(fn: () => T, deps: readonly unknown[]) => {
      const { s } = take();
      if (!("memo" in s) || changed(s.deps, deps)) {
        s.memo = fn();
        s.deps = deps;
      }
      return s.memo as T;
    },
    useCallback: <T>(fn: T, deps: readonly unknown[]) => {
      const { s } = take();
      if (!("memo" in s) || changed(s.deps, deps)) {
        s.memo = fn;
        s.deps = deps;
      }
      return s.memo as T;
    },
    useEffect: (fn: () => unknown, deps?: readonly unknown[]) => {
      const { i } = take();
      st.pending.push({ i, fn, deps });
    },
  };
});
vi.mock("@/app/customers/[customerId]/actions", () => ({
  reviewAction: (...a: unknown[]) => h.st.review(...a),
  bulkApproveAction: (...a: unknown[]) => h.st.bulk(...a),
}));

import { ReviewBoard } from "@/app/customers/[customerId]/review-board";

const st = h.st;
const CID = "11111111-1111-4111-8111-111111111111";
type Props = Parameters<typeof ReviewBoard>[0];

const entry: EntryJson = {
  account_item_id: 1,
  tax_code: 2,
  partner_id: null,
  item_id: null,
  section_id: null,
  tag_ids: [],
  description: "備品",
};
// フィクスチャの案（勘定科目 1／税区分 2）が実際に使う値だけをマスタに入れる
const masters: ReviewQueue["masters"] = {
  account_item: [{ id: 1, name: "備品費" }],
  tax: [{ id: 2, name: "課対仕入8%" }],
  partner: [],
  item: [],
  section: [],
  tag: [],
};
function item(id: string, o: { confidence?: ReviewItem["confidence"]; status?: ReviewItem["txn"]["status"] } = {}): ReviewItem {
  return {
    decisionId: id,
    decidedAt: "2026-11-01T00:00:00Z",
    txn: { id: `t-${id}`, date: "2026-10-31", amount: 1000, direction: "expense", description: `${id}摘要`, walletName: "普通預金", status: o.status ?? "proposed" },
    confidence: o.confidence ?? "high",
    proposal: { ...entry },
    reasons: [],
    forcedLow: [],
    checks: [],
    rule: null,
    past: { matchType: "none", total: 0, majorityShare: null },
    aiReason: null,
    unknowns: [],
    aiUsed: false,
    pastExamples: [],
    holds: [],
  };
}
const ITEMS = [item("H1"), item("H2"), item("H3"), item("M1", { confidence: "medium" }), item("O1", { status: "on_hold", confidence: "medium" })];
const base = (): Props => ({ customerId: CID, canApprove: true, items: ITEMS, masters });
let cur: Props = base();

type El = { type: unknown; props: Record<string, unknown> };
const isEl = (n: unknown): n is El => typeof n === "object" && n !== null && "props" in n;
// hook を使わない関数コンポーネント（EntryEditor / MasterSelect）は展開して公開 props を見る
const walk = (n: unknown, out: El[] = []): El[] => {
  if (Array.isArray(n)) n.forEach((c) => walk(c, out));
  else if (isEl(n)) {
    if (typeof n.type === "function") walk((n.type as (p: unknown) => unknown)(n.props), out);
    else {
      out.push(n);
      walk(n.props.children, out);
    }
  }
  return out;
};
const textOf = (n: unknown): string =>
  Array.isArray(n) ? n.map(textOf).join("") : isEl(n) ? textOf(n.props.children) : typeof n === "string" || typeof n === "number" ? String(n) : "";

type Btn = { disabled?: boolean; onClick?: () => void };
type SelectProps = { value: string | number; onChange: (ev: unknown) => void };
type Ev = { preventDefault: () => void; [k: string]: unknown };

function renderOnce() {
  st.index = 0;
  st.pending = [];
  const root = ReviewBoard(cur) as unknown as ReactNode;
  const els = walk(root);
  for (const e of st.pending) {
    const s = st.slots[e.i]!;
    if (!("deps" in s) || h.changed(s.deps, e.deps)) {
      if (typeof s.cleanup === "function") s.cleanup();
      s.deps = e.deps;
      s.cleanup = e.fn();
    }
  }
  const btn = (re: RegExp) => els.find((e) => e.type === "button" && re.test(textOf(e)))?.props as Btn | undefined;
  const form = els.find((e) => e.type === "form")?.props as
    | { onSubmit: (ev: Ev) => void; onKeyDown: (ev: Ev & { key: string }) => void }
    | undefined;
  return {
    btn,
    form,
    save: els.find((e) => e.type === "button" && e.props.type === "submit")?.props as Btn | undefined,
    reason: els.find((e) => e.type === "input" && e.props.maxLength === 1000)?.props as { onChange: (ev: unknown) => void } | undefined,
    description: els.find((e) => e.type === "input" && e.props.maxLength === 250)?.props as
      | { value: string; onChange: (ev: unknown) => void }
      | undefined,
    // 修正フォームの単一選択（勘定科目・税区分）。MasterSelect は label > select で、value は未選択なら ""
    account: els.filter((e) => e.type === "select" && !e.props.multiple)[0]?.props as SelectProps | undefined,
    tax: els.filter((e) => e.type === "select" && !e.props.multiple)[1]?.props as SelectProps | undefined,
    message: textOf(els.find((e) => e.type === "p" && e.props.className === "error")) || null,
    currentRow: textOf(els.find((e) => e.type === "tr" && e.props.className === "current")),
  };
}
type View = ReturnType<typeof renderOnce>;

/** 描画 → effect → state が動いたら落ち着くまで再描画。next を渡すと props を更新する（router.refresh 相当） */
function render(next?: Partial<Props>): View {
  if (next) cur = { ...cur, ...next };
  for (let n = 0; n < 10; n++) {
    st.dirty = false;
    const v = renderOnce();
    if (!st.dirty) return v;
  }
  throw new Error("render did not settle");
}
function unmount() {
  for (const s of st.slots) if (typeof s.cleanup === "function") s.cleanup();
  st.slots = [];
}

type KeyInit = {
  shiftKey?: boolean;
  tag?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  /** 対象の isContentEditable（継承を含む実機の値を表す） */
  contentEditable?: boolean;
};
function key(k: string, init: KeyInit = {}) {
  const ev = {
    key: k,
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    repeat: init.repeat ?? false,
    isComposing: init.isComposing ?? false,
    defaultPrevented: init.defaultPrevented ?? false,
    target: { tagName: init.tag ?? "BODY", isContentEditable: init.contentEditable ?? false },
    preventDefault: vi.fn(),
  };
  for (const l of [...st.listeners]) l(ev);
  return ev;
}
const evt = (): Ev => ({ preventDefault: vi.fn() });
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const WRITE = {
  approve: /^承認 \(a\)/,
  edit: /^修正 \(e\)/,
  hold: /^保留 \(h\)/,
  reject: /^却下 \(x\)/,
  bulk: /^選択した \d+ 件をまとめて承認$/,
};
const TAB = { high: /^高（/, medium: /^中（/, low: /^低（/, on_hold: /^保留（/ };
const UNKNOWN = /結果を確認できませんでした/;
const BULK_UNKNOWN = /まとめて承認の結果を確認できませんでした/;
const RELOAD = /再読み込み/;
const OK = { ok: true, reviewId: "r-1" };
const REASON = "電話確認待ち";

function withReason(text = REASON) {
  render().reason!.onChange({ target: { value: text } });
  return render();
}
function selectAll() {
  render().btn(/^すべて選択$/)!.onClick!();
  return render();
}
/** 書込みボタン（編集の「修正」は読取に近いので含めない）が、表示されているものすべて無効 */
function expectWritesDisabled(v: View) {
  const bs = [WRITE.approve, WRITE.hold, WRITE.reject, WRITE.bulk].map((re) => v.btn(re)).filter((b): b is Btn => b !== undefined);
  expect(bs.length).toBeGreaterThan(0);
  expect(bs.map((b) => b.disabled)).toEqual(bs.map(() => true));
}
/** 無効化を迂回して、ボタンのハンドラとキーを直接呼ぶ（古いハンドラ・キー連打を表す） */
async function attemptEverything(v: View) {
  for (const re of [WRITE.approve, WRITE.hold, WRITE.reject, WRITE.bulk]) v.btn(re)?.onClick?.();
  key("a");
  key("h");
  key("x");
  key("A", { shiftKey: true });
  await settle();
}
const calls = () => ({ review: st.review.mock.calls.length, bulk: st.bulk.mock.calls.length });

beforeEach(() => {
  st.slots = [];
  st.index = 0;
  st.pending = [];
  st.listeners.clear();
  st.events = [];
  st.review.mockReset();
  st.bulk.mockReset();
  cur = base();
  vi.stubGlobal("window", {
    addEventListener: (t: string, fn: (e: unknown) => void) => {
      if (t === "keydown") {
        st.listeners.add(fn);
        st.events.push("add");
      }
    },
    removeEventListener: (t: string, fn: (e: unknown) => void) => {
      if (t === "keydown" && st.listeners.delete(fn)) st.events.push("remove");
    },
  });
  // 実機では mount 時に effect が走り keydown が登録済み。window のスタブ後に初回描画して同じ状態から始める
  render();
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

describe("ReviewBoard の送信ガード: テスト基盤", () => {
  it("keydown は常に 1 つだけ登録され、再描画で重複せず、アンマウントで解除される", () => {
    render();
    expect(st.listeners.size).toBe(1);
    render();
    render({ items: ITEMS.map((i) => ({ ...i })) });
    expect(st.listeners.size).toBe(1);
    expect(st.events.filter((e) => e === "add").length).toBeGreaterThan(st.events.filter((e) => e === "remove").length);
    unmount();
    expect(st.listeners.size).toBe(0);
  });

  it("キー操作は登録されたリスナー経由で届く（j で次の明細へ）", () => {
    expect(render().currentRow).toContain("H1摘要");
    const ev = key("j");
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(render().currentRow).toContain("H2摘要");
  });
});

describe("ReviewBoard の送信ガード: 送信中（同じ tick の連打と相互排他）", () => {
  it("単件の保留: ボタン連打・キー連打・古いハンドラでも reviewAction は 1 回、まとめては 0 回", async () => {
    const res = deferred<unknown>();
    st.review.mockReturnValue(res.promise);
    const v = withReason();
    v.btn(WRITE.hold)!.onClick!();
    v.btn(WRITE.hold)!.onClick!(); // 再描画前の古いハンドラ
    key("h");
    key("h");
    await attemptEverything(v);
    expect(calls()).toEqual({ review: 1, bulk: 0 });
    expect(st.review).toHaveBeenCalledWith(CID, expect.objectContaining({ decisionId: "H1", action: "hold", reason: REASON, bulk: false }));
    expectWritesDisabled(render());
    res.resolve(OK);
    await settle();
    expect(calls().review).toBe(1);
  });

  it("送信中でも閲覧はできる: タブ切替も j / k も使える", async () => {
    const res = deferred<unknown>();
    st.review.mockReturnValue(res.promise);
    withReason();
    key("h");
    let v = render();
    expect(v.btn(TAB.medium)!.disabled).not.toBe(true);
    expect(v.btn(TAB.on_hold)!.disabled).not.toBe(true);
    expect(key("j").preventDefault).toHaveBeenCalledTimes(1);
    expect(render().currentRow).toContain("H2摘要");
    expect(key("k").preventDefault).toHaveBeenCalledTimes(1);
    v.btn(TAB.medium)!.onClick!();
    v = render();
    expect(v.currentRow).toContain("M1摘要");
    res.resolve(OK);
    await settle();
    expect(calls().review).toBe(1);
  });

  it("単件の承認の送信中に、まとめて承認（ボタン・Shift+A）を押しても送られない", async () => {
    const res = deferred<unknown>();
    st.review.mockReturnValue(res.promise);
    selectAll();
    key("a");
    const v = render();
    expect(calls().review).toBe(1);
    v.btn(WRITE.bulk)?.onClick?.();
    key("A", { shiftKey: true });
    await settle();
    expect(calls()).toEqual({ review: 1, bulk: 0 });
    res.resolve(OK);
    await settle();
  });

  it("まとめて承認の送信中: ボタン連打・Shift+A 連打・単件のキーでも bulkApproveAction は 1 回、reviewAction は 0 回", async () => {
    const res = deferred<unknown>();
    st.bulk.mockReturnValue(res.promise);
    const v = selectAll();
    v.btn(WRITE.bulk)!.onClick!();
    v.btn(WRITE.bulk)!.onClick!(); // 古いハンドラ
    key("A", { shiftKey: true });
    await attemptEverything(v);
    expect(calls()).toEqual({ review: 0, bulk: 1 });
    expectWritesDisabled(render());
    res.resolve({ approved: 3, failures: [] });
    await settle();
    expect(calls()).toEqual({ review: 0, bulk: 1 });
  });

  it("修正の保存の送信中: onSubmit 連打と Ctrl+Enter でも 1 回だけ", async () => {
    const res = deferred<unknown>();
    st.review.mockReturnValue(res.promise);
    key("e");
    const v = render();
    expect(v.form).toBeDefined();
    v.form!.onSubmit(evt());
    v.form!.onSubmit(evt());
    v.form!.onKeyDown({ ...evt(), key: "Enter", ctrlKey: true });
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
    expect(st.review).toHaveBeenCalledWith(CID, expect.objectContaining({ decisionId: "H1", action: "correct" }));
    expect(render().save!.disabled).toBe(true);
    res.resolve(OK);
    await settle();
  });
});

describe("ReviewBoard の送信ガード: 結果不明は再読み込みまでロックする", () => {
  it.each([
    ["非同期の reject", () => st.review.mockRejectedValue(new TypeError("network"))],
    ["同期の throw", () => st.review.mockImplementation(() => { throw new Error("boom"); })],
  ])("単件の保留が %s: 案内が出て、ボタン・キー・古いハンドラのどれでも再送できない", async (_n, arrange) => {
    arrange();
    const first = withReason();
    first.btn(WRITE.hold)!.onClick!();
    await settle();
    expect(calls().review).toBe(1);
    const v = render();
    expect(v.message).toMatch(UNKNOWN);
    expect(v.message).toMatch(RELOAD);
    expectWritesDisabled(v);
    await attemptEverything(v);
    first.btn(WRITE.hold)!.onClick!(); // 結果不明になる前の描画のハンドラ
    await settle();
    expect(calls()).toEqual({ review: 1, bulk: 0 });
    expect(render().message).toMatch(UNKNOWN);
  });

  it("単件の承認が reject: 他の書込み（却下・保留・まとめて）もすべて止まる", async () => {
    st.review.mockRejectedValue(new TypeError("network"));
    selectAll();
    key("a");
    await settle();
    const v = withReason();
    expect(v.message).toMatch(UNKNOWN);
    expectWritesDisabled(v);
    await attemptEverything(v);
    expect(calls()).toEqual({ review: 1, bulk: 0 });
  });

  it("修正の保存が reject: 保存ボタンは無効で、onSubmit・Ctrl+Enter・古いハンドラでも再送されない", async () => {
    st.review.mockRejectedValue(new TypeError("network"));
    key("e");
    const first = render();
    first.form!.onSubmit(evt());
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
    expect(st.review).toHaveBeenCalledWith(CID, expect.objectContaining({ action: "correct" }));
    const v = render();
    expect(v.message).toMatch(UNKNOWN);
    if (v.save) expect(v.save.disabled).toBe(true);
    v.form?.onSubmit(evt());
    v.form?.onKeyDown({ ...evt(), key: "Enter", ctrlKey: true });
    first.form!.onSubmit(evt());
    first.form!.onKeyDown({ ...evt(), key: "Enter", ctrlKey: true });
    await attemptEverything(v);
    expect(calls()).toEqual({ review: 1, bulk: 0 });
  });

  it("まとめて承認が reject: まとめての案内が出て、選択し直しても、まとめても単件も送られない", async () => {
    st.bulk.mockRejectedValue(new TypeError("network"));
    const first = selectAll();
    first.btn(WRITE.bulk)!.onClick!();
    await settle();
    expect(calls().bulk).toBe(1);
    let v = render();
    expect(v.message).toMatch(BULK_UNKNOWN);
    expect(v.message).toMatch(RELOAD);
    v = selectAll(); // 選択の操作そのものは読取側。選び直してもロックは解けない
    expectWritesDisabled(v);
    await attemptEverything(v);
    first.btn(WRITE.bulk)!.onClick!();
    first.btn(WRITE.approve)!.onClick!();
    await settle();
    expect(calls()).toEqual({ review: 0, bulk: 1 });
    expect(render().message).toMatch(BULK_UNKNOWN);
  });

  it("タブ切替・props 更新（新しい items、明細が減る場合）・再描画では解けず、案内も消えない", async () => {
    st.review.mockRejectedValue(new TypeError("network"));
    key("a");
    await settle();
    expect(calls().review).toBe(1);
    withReason();
    for (const tab of [TAB.medium, TAB.on_hold, TAB.low, TAB.high]) {
      let v = render();
      v.btn(tab)!.onClick!();
      if (tab === TAB.low) {
        // 低は空のタブ（フィクスチャに low がない）。理由欄がないので withReason は使わない
        v = render();
        expect(v.reason).toBeUndefined();
        expect(v.message).toMatch(UNKNOWN);
        expect(v.message).toMatch(RELOAD);
        for (const re of [WRITE.approve, WRITE.hold, WRITE.reject, WRITE.bulk]) {
          expect(v.btn(re)?.disabled ?? true).toBe(true);
        }
        await attemptEverything(v);
        expect(calls()).toEqual({ review: 1, bulk: 0 });
        expect(render().message).toMatch(UNKNOWN);
        continue; // 次は high（入力のある表示）に戻り、ロックが残っていることを確認する
      }
      v = withReason();
      expect(v.message).toMatch(UNKNOWN);
      expect(v.btn(WRITE.approve)?.disabled ?? true).toBe(true);
      expect(v.btn(WRITE.reject)?.disabled ?? true).toBe(true);
      expect(v.btn(WRITE.hold)?.disabled ?? true).toBe(true);
      await attemptEverything(v);
    }
    for (const items of [ITEMS.map((i) => ({ ...i })), ITEMS.filter((i) => i.decisionId !== "H1")]) {
      const v = render({ items });
      expect(v.message).toMatch(UNKNOWN);
      expect(v.message).toMatch(RELOAD);
      expectWritesDisabled(withReason());
      await attemptEverything(render());
      render();
    }
    expect(calls()).toEqual({ review: 1, bulk: 0 });
  });

  it("実際の再マウント（再読み込み）で解除され、案内も消えて、次の操作が 1 回送られる", async () => {
    st.review.mockRejectedValueOnce(new TypeError("network"));
    key("a");
    await settle();
    expect(render().message).toMatch(UNKNOWN);
    unmount();
    const v = render();
    expect(v.message).toBeNull();
    expect(v.btn(WRITE.approve)!.disabled).not.toBe(true);
    st.review.mockResolvedValue(OK);
    key("a");
    await settle();
    expect(calls().review).toBe(2);
  });
});

describe("ReviewBoard の送信ガード: 確定した結果ではロックしない", () => {
  it("単件の既知の拒否: 拒否の文が出て、意図した再試行は送られる", async () => {
    st.review.mockResolvedValueOnce({ ok: false, error: "この明細はすでに確認済みです（approved）" });
    key("a");
    await settle();
    const v = render();
    expect(v.message).toBe("この明細はすでに確認済みです（approved）");
    expect(v.message).not.toMatch(UNKNOWN);
    expect(v.btn(WRITE.approve)!.disabled).not.toBe(true);
    expect(v.btn(WRITE.reject)!.disabled).not.toBe(true);
    st.review.mockResolvedValue(OK);
    key("a");
    await settle();
    expect(calls().review).toBe(2);
    expect(render().message).toBeNull();
  });

  it("まとめての一部が拒否（failures）: 件数と理由が出て、ロックされず、続けて単件もまとめても送れる", async () => {
    st.bulk.mockResolvedValueOnce({ approved: 2, failures: [{ decisionId: "H3", error: "より新しい仕訳候補があります。画面を更新してください" }] });
    selectAll().btn(WRITE.bulk)!.onClick!();
    await settle();
    const v = render();
    expect(v.message).toContain("2件を承認、1件は承認できませんでした");
    expect(v.message).not.toMatch(UNKNOWN);
    expect(v.btn(WRITE.approve)!.disabled).not.toBe(true);
    st.review.mockResolvedValue(OK);
    key("a");
    await settle();
    expect(calls()).toEqual({ review: 1, bulk: 1 });
  });

  it("確定した成功（単件・まとめて）: 結果不明ロックにならず、続けて操作できる", async () => {
    st.review.mockResolvedValue(OK);
    st.bulk.mockResolvedValue({ approved: 3, failures: [] });
    key("a");
    await settle();
    let v = render();
    expect(v.message).toBeNull();
    expect(v.btn(WRITE.approve)!.disabled).not.toBe(true);
    v = selectAll();
    v.btn(WRITE.bulk)!.onClick!();
    await settle();
    v = render();
    expect(v.message).toBe("3件を承認しました");
    expect(v.btn(WRITE.approve)!.disabled).not.toBe(true);
    key("x");
    await settle();
    expect(calls()).toEqual({ review: 2, bulk: 1 });
  });
});

describe("ReviewBoard の送信ガード: ローカルの入力不正と役割", () => {
  it("保留の理由が空・空白だけ: 送信せず案内だけで、ガードを掴まない（理由を直せば 1 回送られる）", async () => {
    st.review.mockResolvedValue(OK);
    key("h");
    await settle();
    expect(render().message).toBe("保留の理由を入力してください");
    render().btn(WRITE.hold)!.onClick!();
    withReason("　 ");
    key("h");
    await settle();
    expect(calls().review).toBe(0);
    expect(render().message).toBe("保留の理由を入力してください");
    withReason();
    key("h");
    await settle();
    expect(calls().review).toBe(1);
    expect(st.review).toHaveBeenCalledWith(CID, expect.objectContaining({ action: "hold", reason: REASON }));
    expect(render().message).toBeNull();
  });

  it("理由が不正で拒否されたあとでも、承認など他の操作は送れる", async () => {
    st.review.mockResolvedValue(OK);
    key("h");
    render(); // 理由エラーの state 更新を反映してから次のキー（別イベント）
    key("a");
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
    expect(st.review).toHaveBeenCalledWith(CID, expect.objectContaining({ action: "approve" }));
  });

  it("担当者（canApprove=false）: 承認・修正・却下・まとめての表示も操作もなく、保留だけ理由付きで送れる", async () => {
    st.review.mockResolvedValue(OK);
    render({ canApprove: false });
    let v = render();
    for (const re of [WRITE.approve, WRITE.edit, WRITE.reject, WRITE.bulk, /^すべて選択$/]) expect(v.btn(re)).toBeUndefined();
    key("a");
    key("e");
    key("x");
    key("A", { shiftKey: true });
    await settle();
    expect(render().form).toBeUndefined();
    expect(calls()).toEqual({ review: 0, bulk: 0 });
    v = withReason();
    key("h");
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
    expect(st.review).toHaveBeenCalledWith(CID, expect.objectContaining({ decisionId: "H1", action: "hold", finalEntry: null }));
  });

  it("担当者（canApprove=false）: 修飾キー付きのキーでも何も送られず、保留だけは従来どおり送れる", async () => {
    st.review.mockResolvedValue(OK);
    render({ canApprove: false });
    for (const m of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      for (const k of ["a", "x", "e", "h"]) expect(key(k, m).preventDefault).not.toHaveBeenCalled();
      expect(key("A", { shiftKey: true, ...m }).preventDefault).not.toHaveBeenCalled();
    }
    await settle();
    expect(render().form).toBeUndefined();
    expect(calls()).toEqual({ review: 0, bulk: 0 });
    withReason();
    key("h");
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
    expect(st.review).toHaveBeenCalledWith(CID, expect.objectContaining({ action: "hold" }));
  });

  it("担当者でも結果不明のあとは保留を再送できない（ボタン・キー）", async () => {
    st.review.mockRejectedValue(new TypeError("network"));
    render({ canApprove: false });
    const first = withReason();
    first.btn(WRITE.hold)!.onClick!();
    await settle();
    const v = render();
    expect(v.message).toMatch(UNKNOWN);
    expect(v.btn(WRITE.hold)!.disabled).toBe(true);
    v.btn(WRITE.hold)!.onClick!();
    key("h");
    await settle();
    expect(calls().review).toBe(1);
  });
});

describe("ReviewBoard のキーボード安全性: 単独の明示的なショートカットだけが効く", () => {
  const MODS: [string, KeyInit][] = [
    ["Ctrl", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
    ["Alt", { altKey: true }],
  ];
  const IGNORED: [string, KeyInit][] = [
    ["repeat（長押し）", { repeat: true }],
    ["isComposing（IME 変換中）", { isComposing: true }],
    ["defaultPrevented（処理済み）", { defaultPrevented: true }],
    ["contenteditable（継承を含む）", { tag: "DIV", contentEditable: true }],
    ["contenteditable の子孫（SPAN）", { tag: "SPAN", contentEditable: true }],
    ["INPUT", { tag: "INPUT" }],
    ["SELECT", { tag: "SELECT" }],
    ["TEXTAREA", { tag: "TEXTAREA" }],
  ];

  /** 書込みなし・preventDefault なし・画面状態（現在の行、修正フォーム、選択）が変わらない */
  async function expectIgnored(ev: ReturnType<typeof key>, selected: boolean) {
    await settle();
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(calls()).toEqual({ review: 0, bulk: 0 });
    const v = render();
    expect(v.form).toBeUndefined();
    expect(v.currentRow).toContain("H1摘要");
    // まとめて承認ボタンは常に表示される。選択 0 件なら「選択した 0 件」で無効、選択済みなら有効のまま
    const bulk = v.btn(WRITE.bulk);
    expect(bulk).toBeDefined();
    expect(bulk!.disabled === true).toBe(!selected);
    expect(v.message).toBeNull();
  }

  describe.each(MODS)("%s 付き", (_name, mod) => {
    it.each(["a", "x", "h", "e", "j", "k", " "])("%j は何も起こさない（承認・却下・保留・修正・移動・選択）", async (k) => {
      st.review.mockResolvedValue(OK);
      st.bulk.mockResolvedValue({ approved: 3, failures: [] });
      await expectIgnored(key(k, mod), false);
    });

    it("A + Shift（Ctrl+Shift+A など）はまとめて承認を送らず、選択済みでも変わらない", async () => {
      st.bulk.mockResolvedValue({ approved: 3, failures: [] });
      selectAll();
      await expectIgnored(key("A", { shiftKey: true, ...mod }), true);
    });

    it("j / k の移動も起きない（ブラウザ・OS のショートカットに譲る）", async () => {
      const a = key("j", mod);
      const b = key("k", mod);
      expect(a.preventDefault).not.toHaveBeenCalled();
      expect(b.preventDefault).not.toHaveBeenCalled();
      expect(render().currentRow).toContain("H1摘要");
    });

    it("無視したあとでも、ロックされず単独の a は承認を 1 回送る", async () => {
      st.review.mockResolvedValue(OK);
      key("a", mod);
      await settle();
      expect(calls().review).toBe(0);
      const ev = key("a");
      await settle();
      expect(ev.preventDefault).toHaveBeenCalledTimes(1);
      expect(calls()).toEqual({ review: 1, bulk: 0 });
      expect(st.review).toHaveBeenCalledWith(CID, expect.objectContaining({ decisionId: "H1", action: "approve" }));
    });
  });

  describe.each(IGNORED)("%s のキーは無視する", (_name, init) => {
    it.each(["a", "x", "h", "e", "j", "k", " "])("%j は何も起こさない", async (k) => {
      st.review.mockResolvedValue(OK);
      await expectIgnored(key(k, init), false);
    });

    it("選択済みでも Shift+A はまとめて承認を送らない", async () => {
      st.bulk.mockResolvedValue({ approved: 3, failures: [] });
      selectAll();
      await expectIgnored(key("A", { shiftKey: true, ...init }), true);
    });
  });

  it("isContentEditable が偽の DIV（編集対象ではない）では、従来どおり a が効く", async () => {
    st.review.mockResolvedValue(OK);
    const ev = key("a", { tag: "DIV", contentEditable: false });
    await settle();
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual({ review: 1, bulk: 0 });
  });

  it("正の確認: 単独の a は承認を 1 回、preventDefault も 1 回", async () => {
    st.review.mockResolvedValue(OK);
    const ev = key("a");
    await settle();
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual({ review: 1, bulk: 0 });
    expect(st.review).toHaveBeenCalledWith(CID, expect.objectContaining({ decisionId: "H1", action: "approve", bulk: false }));
  });

  it("正の確認: 選択済みの Shift+A（修飾なし）はまとめて承認を 1 回送り、単件は送らない", async () => {
    st.bulk.mockResolvedValue({ approved: 3, failures: [] });
    selectAll();
    const ev = key("A", { shiftKey: true });
    await settle();
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual({ review: 0, bulk: 1 });
    expect(render().message).toBe("3件を承認しました");
  });

  it("正の確認: 単独の x / h / e / j / k / スペースは従来どおり動く", async () => {
    st.review.mockResolvedValue(OK);
    expect(key("j").preventDefault).toHaveBeenCalledTimes(1);
    expect(render().currentRow).toContain("H2摘要");
    expect(key("k").preventDefault).toHaveBeenCalledTimes(1);
    expect(render().currentRow).toContain("H1摘要");
    expect(key(" ").preventDefault).toHaveBeenCalled();
    expect(render().btn(WRITE.bulk)).toBeDefined();
    expect(key("e").preventDefault).toHaveBeenCalledTimes(1);
    expect(render().form).toBeDefined();
    unmount();
    st.listeners.clear();
    render();
    expect(key("x").preventDefault).toHaveBeenCalledTimes(1);
    await settle();
    expect(st.review).toHaveBeenCalledWith(CID, expect.objectContaining({ decisionId: "H1", action: "reject" }));
  });

  it("送信中は単独の a でも二重に送られない（送信ガードは変わらない）", async () => {
    const res = deferred<unknown>();
    st.review.mockReturnValue(res.promise);
    key("a");
    key("a");
    key("a", { ctrlKey: true });
    await settle();
    expect(calls()).toEqual({ review: 1, bulk: 0 });
    res.resolve(OK);
    await settle();
    expect(calls()).toEqual({ review: 1, bulk: 0 });
  });

  it("修正フォームを開いている間は、単独キーも無視される（editing の抑止を維持）", async () => {
    key("e");
    expect(render().form).toBeDefined();
    const ev = key("a");
    await settle();
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(calls()).toEqual({ review: 0, bulk: 0 });
  });

  it("修正フォームの Ctrl+Enter は引き続き対応する操作で、ボード全体のキー抑止の対象外", async () => {
    st.review.mockResolvedValue(OK);
    key("e");
    const v = render();
    v.form!.onKeyDown({ ...evt(), key: "Enter", ctrlKey: true });
    await settle();
    expect(calls().review).toBe(1);
    expect(st.review).toHaveBeenCalledWith(CID, expect.objectContaining({ decisionId: "H1", action: "correct" }));
  });
});

describe("EntryEditor のキーボード安全性: 変換中・長押し・処理済みのキーは取消も保存もしない", () => {
  const EDITED = "編集済み摘要";
  type EditorKeyInit = { ctrlKey?: boolean; metaKey?: boolean; composing?: boolean; repeat?: boolean; defaultPrevented?: boolean };

  /** React の合成イベントを模す: 変換中は nativeEvent.isComposing だけ、repeat / defaultPrevented は合成側と native の両方 */
  function editorKey(v: View, k: string, init: EditorKeyInit = {}) {
    const ev = {
      ...evt(),
      key: k,
      ctrlKey: init.ctrlKey ?? false,
      metaKey: init.metaKey ?? false,
      repeat: init.repeat ?? false,
      defaultPrevented: init.defaultPrevented ?? false,
      nativeEvent: { isComposing: init.composing ?? false, repeat: init.repeat ?? false, defaultPrevented: init.defaultPrevented ?? false },
    };
    v.form!.onKeyDown(ev);
    return ev;
  }
  /** 修正フォームを開き、摘要を実際に編集した状態にする */
  function openEdited() {
    key("e");
    render().description!.onChange({ target: { value: EDITED } });
    const v = render();
    expect(v.form).toBeDefined();
    expect(v.description!.value).toBe(EDITED);
    return v;
  }
  /** フォームが開いたまま、編集内容が残り、送信されていない */
  async function expectEditorIntact() {
    await settle();
    const v = render();
    expect(v.form).toBeDefined();
    expect(v.description!.value).toBe(EDITED);
    expect(calls()).toEqual({ review: 0, bulk: 0 });
  }

  const IGNORED_EDITOR: [string, EditorKeyInit][] = [
    ["変換中（nativeEvent.isComposing）", { composing: true }],
    ["repeat（長押し）", { repeat: true }],
    ["defaultPrevented（処理済み）", { defaultPrevented: true }],
  ];

  describe.each(IGNORED_EDITOR)("%s", (_name, init) => {
    it("Escape: フォームも編集した摘要も残り、送信されない", async () => {
      st.review.mockResolvedValue(OK);
      editorKey(openEdited(), "Escape", init);
      await expectEditorIntact();
    });

    it.each([
      ["Ctrl", { ctrlKey: true }],
      ["Meta", { metaKey: true }],
    ])("%s+Enter: 保存されず、フォームも編集内容も残る", async (_m, mod) => {
      st.review.mockResolvedValue(OK);
      editorKey(openEdited(), "Enter", { ...init, ...mod });
      await expectEditorIntact();
    });

    it("無視したあとでもロックされず、通常の Ctrl+Enter は編集した摘要で 1 回だけ保存する", async () => {
      st.review.mockResolvedValue(OK);
      editorKey(openEdited(), "Enter", { ...init, ctrlKey: true });
      expect(calls().review).toBe(0);
      editorKey(render(), "Enter", { ctrlKey: true });
      await settle();
      expect(st.review).toHaveBeenCalledTimes(1);
      expect(st.review).toHaveBeenCalledWith(
        CID,
        expect.objectContaining({ decisionId: "H1", action: "correct", finalEntry: expect.objectContaining({ description: EDITED }) }),
      );
    });
  });

  it("正の確認: 通常の Escape はフォームを閉じ、送信しない", async () => {
    st.review.mockResolvedValue(OK);
    editorKey(openEdited(), "Escape");
    await settle();
    expect(render().form).toBeUndefined();
    expect(calls()).toEqual({ review: 0, bulk: 0 });
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
  ])("正の確認: 通常の %s+Enter は編集した摘要で correct を 1 回送る", async (_m, mod) => {
    st.review.mockResolvedValue(OK);
    editorKey(openEdited(), "Enter", mod);
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
    expect(st.review).toHaveBeenCalledWith(
      CID,
      expect.objectContaining({ decisionId: "H1", action: "correct", finalEntry: expect.objectContaining({ description: EDITED }) }),
    );
    expect(calls().bulk).toBe(0);
  });

  it("送信ガードは変わらない: 送信中の Ctrl+Enter 連打でも 1 回だけ", async () => {
    const res = deferred<unknown>();
    st.review.mockReturnValue(res.promise);
    const v = openEdited();
    editorKey(v, "Enter", { ctrlKey: true });
    editorKey(v, "Enter", { ctrlKey: true }); // 再描画前の古いハンドラ
    editorKey(render(), "Enter", { metaKey: true });
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
    res.resolve(OK);
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
  });
});

describe("EntryEditor の税区分: 未選択と正当な 0 を区別する", () => {
  const TAX_MASTERS: ReviewQueue["masters"] = {
    ...masters,
    account_item: [{ id: 101, name: "通信費" }],
    tax: [
      { id: 0, name: "対象外" },
      { id: 21, name: "課対仕入10%" },
    ],
  };
  const withTax = (tax_code: number, account_item_id = 101): ReviewItem[] =>
    ITEMS.map((i) => (i.decisionId === "H1" ? { ...i, proposal: { ...entry, account_item_id, tax_code } } : i));
  const noProposal = (): ReviewItem[] => ITEMS.map((i) => (i.decisionId === "H1" ? { ...i, proposal: null } : i));
  const pick = (s: SelectProps | undefined, value: string) => s!.onChange({ target: { value } });
  const ctrlEnter = (v: View) => v.form!.onKeyDown({ ...evt(), key: "Enter", ctrlKey: true });
  /** 保存の 3 経路（ボタンの状態・onSubmit・Ctrl+Enter）がすべて止まっている */
  async function expectNoSave() {
    const v = render();
    expect(v.save!.disabled).toBe(true);
    v.form!.onSubmit(evt());
    ctrlEnter(v);
    await settle();
    expect(calls()).toEqual({ review: 0, bulk: 0 });
  }
  const sent = () => (st.review.mock.calls[0]![1] as { finalEntry: EntryJson }).finalEntry;

  it("既存の案が税区分 0: 「対象外」が選択済みで、ボタンも Ctrl+Enter も tax_code: 0 を 1 回送る", async () => {
    st.review.mockResolvedValue(OK);
    render({ masters: TAX_MASTERS, items: withTax(0) });
    key("e");
    const v = render();
    expect(v.tax!.value).toBe(0);
    expect(v.save!.disabled).not.toBe(true);
    ctrlEnter(v);
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual({ ...entry, account_item_id: 101, tax_code: 0 });
  });

  it("既存の案が税区分 0: 保存ボタン（onSubmit）でも 0 を 1 回送る", async () => {
    st.review.mockResolvedValue(OK);
    render({ masters: TAX_MASTERS, items: withTax(0) });
    key("e");
    render().form!.onSubmit(evt());
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
    expect(sent().tax_code).toBe(0);
  });

  it("提案なし: 税区分は未選択（0 を既定にしない）で、保存は 3 経路とも止まり、選ぶと保存できる", async () => {
    st.review.mockResolvedValue(OK);
    render({ masters: TAX_MASTERS, items: noProposal() });
    key("e");
    const v = render();
    expect(v.tax!.value).toBe("");
    pick(v.account, "101");
    await expectNoSave(); // 勘定科目だけ選んでも、税区分が未選択なら送らない
    pick(render().tax, "0");
    ctrlEnter(render());
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
    expect(sent()).toMatchObject({ account_item_id: 101, tax_code: 0 });
  });

  it("0 をクリアすると未選択（null）になり、ボタン・onSubmit・Ctrl+Enter が止まる。null も 0 も送らない", async () => {
    st.review.mockResolvedValue(OK);
    render({ masters: TAX_MASTERS, items: withTax(0) });
    key("e");
    pick(render().tax, "");
    expect(render().tax!.value).toBe("");
    await expectNoSave();
    expect(st.review).not.toHaveBeenCalled();
  });

  it("クリアしたあとで 0 を選び直すと、tax_code: 0 を 1 回だけ送る", async () => {
    st.review.mockResolvedValue(OK);
    render({ masters: TAX_MASTERS, items: withTax(0) });
    key("e");
    pick(render().tax, "");
    await expectNoSave();
    pick(render().tax, "0");
    const v = render();
    expect(v.tax!.value).toBe(0);
    expect(v.save!.disabled).not.toBe(true);
    ctrlEnter(v);
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
    expect(sent().tax_code).toBe(0);
  });

  it("通常の税区分 21: 従来どおり tax_code: 21 を 1 回送る。0 に切り替えても 0 で送る", async () => {
    st.review.mockResolvedValue(OK);
    render({ masters: TAX_MASTERS, items: withTax(21) });
    key("e");
    let v = render();
    expect(v.tax!.value).toBe(21);
    ctrlEnter(v);
    await settle();
    expect(sent().tax_code).toBe(21);
    st.review.mockClear();
    unmount();
    render({ masters: TAX_MASTERS, items: withTax(21) });
    key("e");
    pick(render().tax, "0");
    v = render();
    ctrlEnter(v);
    await settle();
    expect(sent().tax_code).toBe(0);
  });

  it("税区分マスタに 0 がない: 案が 0 でも保存は 3 経路とも止まる。マスタにある 21 は保存できる", async () => {
    st.review.mockResolvedValue(OK);
    const noZero = { ...TAX_MASTERS, tax: [{ id: 21, name: "課対仕入10%" }] };
    render({ masters: noZero, items: withTax(0) });
    key("e");
    await expectNoSave();
    pick(render().tax, "21");
    ctrlEnter(render());
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
    expect(sent().tax_code).toBe(21);
  });

  it("税区分マスタが空（取得できていない）: 0 は保存できない", async () => {
    render({ masters: { ...TAX_MASTERS, tax: [] }, items: withTax(0) });
    key("e");
    await expectNoSave();
  });

  it("マスタにない正の税区分（21 / 999）: 保存は 3 経路とも止まる。マスタにある 0 は保存できる", async () => {
    st.review.mockResolvedValue(OK);
    const onlyZero = { ...TAX_MASTERS, tax: [{ id: 0, name: "対象外" }] };
    for (const code of [21, 999]) {
      render({ masters: onlyZero, items: withTax(code) });
      key("e");
      await expectNoSave();
      unmount();
    }
    render({ masters: onlyZero, items: withTax(21) });
    key("e");
    pick(render().tax, "0");
    ctrlEnter(render());
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
    expect(sent().tax_code).toBe(0);
  });

  it("不正な税区分（負の値・安全でない整数・小数）: マスタにあっても保存は 3 経路とも止まる", async () => {
    for (const code of [-1, 2 ** 60, 1.5]) {
      render({ masters: { ...TAX_MASTERS, tax: [{ id: code, name: "不正" }] }, items: withTax(code) });
      key("e");
      await expectNoSave();
      unmount();
    }
    render({ masters: TAX_MASTERS, items: withTax(-1) }); // マスタにない負の値
    key("e");
    await expectNoSave();
  });

  it("勘定科目が未選択（0）なら、税区分が有効な 0 でも保存できない", async () => {
    render({ masters: TAX_MASTERS, items: withTax(0, 0) });
    key("e");
    await expectNoSave();
  });

  it("送信中は、税区分 0 の保存を連打しても 1 回だけ（ボタン・onSubmit・Ctrl+Enter・古いハンドラ）", async () => {
    const res = deferred<unknown>();
    st.review.mockReturnValue(res.promise);
    render({ masters: TAX_MASTERS, items: withTax(0) });
    key("e");
    const v = render();
    v.form!.onSubmit(evt());
    v.form!.onSubmit(evt());
    ctrlEnter(v);
    ctrlEnter(render());
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
    expect(render().save!.disabled).toBe(true);
    res.resolve(OK);
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
  });

  it("結果不明のあとは、税区分 0 でも再送できない", async () => {
    st.review.mockRejectedValue(new TypeError("network"));
    render({ masters: TAX_MASTERS, items: withTax(0) });
    key("e");
    const first = render();
    first.form!.onSubmit(evt());
    await settle();
    const v = render();
    expect(v.message).toMatch(UNKNOWN);
    v.form?.onSubmit(evt());
    if (v.form) ctrlEnter(v);
    first.form!.onSubmit(evt());
    await settle();
    expect(st.review).toHaveBeenCalledTimes(1);
  });

  it("変換中・長押しの Ctrl+Enter は、税区分 0 でも送らない（IME 制御を維持）", async () => {
    render({ masters: TAX_MASTERS, items: withTax(0) });
    key("e");
    const v = render();
    for (const nativeEvent of [{ isComposing: true }, { repeat: true }]) {
      v.form!.onKeyDown({ ...evt(), key: "Enter", ctrlKey: true, nativeEvent, repeat: "repeat" in nativeEvent });
    }
    await settle();
    expect(calls()).toEqual({ review: 0, bulk: 0 });
  });

  it("担当者（canApprove=false）: 税区分 0 の案があっても修正フォームは開かず、何も送られない", async () => {
    render({ masters: TAX_MASTERS, items: withTax(0), canApprove: false });
    key("e");
    await settle();
    expect(render().form).toBeUndefined();
    expect(calls()).toEqual({ review: 0, bulk: 0 });
  });
});
