import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuspectedDuplicate } from "@/lib/review/queue";

// 実際の DuplicatesPanel のハンドラを、最小の hook 実装（useState / useRef）で動かす。
// 再描画は render() を呼んだときだけ起きる。呼ぶ前のハンドラは「再描画前に届いた古いハンドラ」を表す。
// DOM・ブラウザは通らない（合成テスト）。
const h = vi.hoisted(() => {
  type Slot = { value?: unknown; current?: unknown };
  const st = {
    slots: [] as Slot[],
    index: 0,
    dirty: false,
    resolve: vi.fn(),
  };
  return { st };
});

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  const { st } = h;
  const take = () => {
    const i = st.index++;
    return st.slots[i] ?? (st.slots[i] = {});
  };
  return {
    ...actual,
    useState: <T>(init: T) => {
      const s = take();
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
      const s = take();
      if (!("current" in s)) s.current = init;
      return s as { current: T };
    },
  };
});
vi.mock("@/app/customers/[customerId]/actions", () => ({
  resolveDuplicateAction: (...a: unknown[]) => h.st.resolve(...a),
}));

import { DuplicatesPanel } from "@/app/customers/[customerId]/duplicates-panel";
import { submitDuplicateResolution, type DuplicateResolutionInput } from "@/lib/review/submit";
import type { SupabaseClient } from "@supabase/supabase-js";

const st = h.st;
const CID = "11111111-1111-4111-8111-111111111111";
type Props = Parameters<typeof DuplicatesPanel>[0];

function dup(id: string, date: string, amount: number, description: string): SuspectedDuplicate {
  return {
    id,
    date,
    amount,
    direction: "expense",
    description,
    walletName: "普通預金",
    original: { id: `o-${id}`, date, amount, description, status: "proposed" },
  };
}
const ITEMS = [dup("D1", "2026-10-31", 1000, "振込 テスト商店A"), dup("D2", "2026-10-30", 2000, "振込 テスト商店B")];
const base = (): Props => ({ customerId: CID, canApprove: true, items: ITEMS });
let cur: Props = base();

type El = { type: unknown; props: Record<string, unknown> };
const isEl = (n: unknown): n is El => typeof n === "object" && n !== null && "props" in n;
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
const DISTINCT = /別の取引として扱う/;
const DUPLICATE = /重複として除外/;

function renderOnce() {
  st.index = 0;
  const root = DuplicatesPanel(cur) as unknown as ReactNode;
  const els = walk(root);
  const rows = els
    .filter((e) => e.type === "tr" && walk(e.props.children).some((c) => c.type === "td"))
    .map((tr) => {
      const inner = walk(tr.props.children);
      const btn = (re: RegExp) => inner.find((e) => e.type === "button" && re.test(textOf(e)))?.props as Btn | undefined;
      return { text: textOf(tr), distinct: btn(DISTINCT), duplicate: btn(DUPLICATE) };
    });
  return {
    empty: root === null,
    rows,
    /** 行 index の判断ボタン（表示されていなければ undefined） */
    distinct: (i: number) => rows[i]?.distinct,
    duplicate: (i: number) => rows[i]?.duplicate,
    message: textOf(els.find((e) => e.type === "p" && e.props.className === "error")) || null,
  };
}
type View = ReturnType<typeof renderOnce>;

/** 描画 → state が動いたら落ち着くまで再描画。next を渡すと props を更新する（router.refresh 相当） */
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
  st.slots = [];
}

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

const UNKNOWN = /操作の結果を確認できませんでした/;
const RELOAD = /再読み込み/;
const OK = { ok: true };
const calls = () => st.resolve.mock.calls.length;

/** 表示されているすべての判断ボタンが無効 */
function expectAllDisabled(v: View, expectedCount: number) {
  const bs = v.rows.flatMap((r) => [r.distinct, r.duplicate]).filter((b): b is Btn => b !== undefined);
  expect(bs).toHaveLength(expectedCount);
  expect(bs.map((b) => b.disabled)).toEqual(bs.map(() => true));
}
function expectAllEnabled(v: View, expectedCount: number) {
  const bs = v.rows.flatMap((r) => [r.distinct, r.duplicate]).filter((b): b is Btn => b !== undefined);
  expect(bs).toHaveLength(expectedCount);
  expect(bs.map((b) => b.disabled)).toEqual(bs.map(() => false));
}
/** 無効化を迂回して、すべての行・両方の判断の古いハンドラを直接呼ぶ */
async function attemptEverything(v: View) {
  for (let i = 0; i < v.rows.length; i++) {
    v.distinct(i)?.onClick?.();
    v.duplicate(i)?.onClick?.();
  }
  await settle();
}

beforeEach(() => {
  st.slots = [];
  st.index = 0;
  st.resolve.mockReset();
  cur = base();
  render();
});
afterEach(() => {
  unmount();
});

describe("DuplicatesPanel の送信ガード: テスト基盤", () => {
  it("2 行・各行 2 つのボタン（承認者）が見え、担当者は「別の取引」だけが見える。0 件なら何も描かない", () => {
    const v = render();
    expect(v.rows).toHaveLength(2);
    expect(v.rows[0]!.text).toContain("テスト商店A");
    expect(v.rows[1]!.text).toContain("テスト商店B");
    expect(v.rows.every((r) => r.distinct && r.duplicate)).toBe(true);
    const staff = render({ canApprove: false });
    expect(staff.rows.every((r) => r.distinct && !r.duplicate)).toBe(true);
    expect(render({ items: [] }).empty).toBe(true);
  });

  it("ボタンの操作は対象の明細と判断だけを送る（reason は null）", async () => {
    st.resolve.mockResolvedValue(OK);
    render({ canApprove: true, items: ITEMS });
    render().duplicate(1)!.onClick!();
    await settle();
    expect(st.resolve).toHaveBeenCalledWith(CID, { bankTransactionId: "D2", resolution: "duplicate", reason: null });
  });
});

describe("DuplicatesPanel の送信ガード: 送信中（同じ tick の連打と相互排他）", () => {
  // 修正前に失敗: busy は再描画後にしか反映されず、古いハンドラが 2 回目を送る（calls() が 2 になる）
  it("同じ行の「別の取引」を再描画前に連打しても 1 回だけ", async () => {
    const res = deferred<unknown>();
    st.resolve.mockReturnValue(res.promise);
    const v = render();
    v.distinct(0)!.onClick!();
    v.distinct(0)!.onClick!();
    v.distinct(0)!.onClick!();
    await settle();
    expect(calls()).toBe(1);
    expect(st.resolve).toHaveBeenCalledWith(CID, { bankTransactionId: "D1", resolution: "distinct", reason: null });
    res.resolve(OK);
    await settle();
    expect(calls()).toBe(1);
  });

  // 修正前に失敗: 別の行の古いハンドラも送られる
  it("別の行の「別の取引」の古いハンドラは、1 件目の送信中は送られない", async () => {
    const res = deferred<unknown>();
    st.resolve.mockReturnValue(res.promise);
    const v = render();
    v.distinct(0)!.onClick!();
    v.distinct(1)!.onClick!();
    await settle();
    expect(calls()).toBe(1);
    expect(st.resolve.mock.calls[0]![1]).toMatchObject({ bankTransactionId: "D1" });
    res.resolve(OK);
    await settle();
  });

  // 修正前に失敗: 反対の判断（除外）が同じ行・別の行で送られる
  it.each([
    ["distinct → 同じ行の duplicate", "distinct", 0, "duplicate", 0],
    ["distinct → 別の行の duplicate", "distinct", 0, "duplicate", 1],
    ["duplicate → 同じ行の distinct", "duplicate", 0, "distinct", 0],
    ["duplicate → 別の行の distinct", "duplicate", 1, "distinct", 0],
    ["duplicate → 別の行の duplicate", "duplicate", 0, "duplicate", 1],
  ] as const)("反対・別の判断の古いハンドラも送られない: %s", async (_n, first, firstRow, second, secondRow) => {
    const res = deferred<unknown>();
    st.resolve.mockReturnValue(res.promise);
    const v = render();
    v[first](firstRow)!.onClick!();
    v[second](secondRow)!.onClick!();
    await settle();
    expect(calls()).toBe(1);
    expect(st.resolve.mock.calls[0]![1]).toMatchObject({ resolution: first });
    res.resolve(OK);
    await settle();
    expect(calls()).toBe(1);
  });

  // 修正前に失敗の可能性: 表示の無効化は再描画後なので、再描画後に全ボタン無効であることを固定する
  it("送信中は全行の両方のボタンが無効で、再描画後の新しいハンドラでも送られない", async () => {
    const res = deferred<unknown>();
    st.resolve.mockReturnValue(res.promise);
    render().distinct(0)!.onClick!();
    const v = render();
    expectAllDisabled(v, 4);
    await attemptEverything(v);
    expect(calls()).toBe(1);
    res.resolve(OK);
    await settle();
    expect(calls()).toBe(1);
  });
});

describe("DuplicatesPanel の送信ガード: 結果不明は再マウントまでロックする", () => {
  // 修正前に失敗: finally が setBusy(false) するのでボタンが再び有効になり、古いハンドラも送れる
  it.each([
    ["非同期の reject", () => st.resolve.mockRejectedValue(new TypeError("network: secret-host:5432"))],
    ["同期の throw", () => st.resolve.mockImplementation(() => { throw new Error("boom: internal stack"); })],
    ["結果が undefined", () => st.resolve.mockResolvedValue(undefined)],
  ])("%s: 案内が出て、両方の判断が全行で止まり、古いハンドラでも再送できない", async (_n, arrange) => {
    arrange();
    const first = render();
    first.distinct(0)!.onClick!();
    await settle();
    expect(calls()).toBe(1);
    const v = render();
    expect(v.message).toMatch(UNKNOWN);
    expect(v.message).toMatch(RELOAD);
    expectAllDisabled(v, 4);
    await attemptEverything(v);
    await attemptEverything(first); // 結果不明になる前の描画のハンドラ
    expect(calls()).toBe(1);
    expect(render().message).toMatch(UNKNOWN);
  });

  // 修正前に失敗: 内部例外の文言を出さない確認自体は現状でも通るが、回帰として固定する
  it("案内に内部の例外の文言（メッセージ・ホスト名・スタック）を出さない", async () => {
    st.resolve.mockRejectedValue(new Error("connect ECONNREFUSED secret-host:5432\n    at internal/stack.js:1"));
    render().duplicate(0)!.onClick!();
    await settle();
    const m = render().message!;
    expect(m).toMatch(UNKNOWN);
    expect(m).not.toMatch(/ECONNREFUSED|secret-host|5432|stack|Error/);
  });

  // 修正前に失敗: 結果不明のあと、反対の判断（除外）が別の行から送れる
  it("distinct が結果不明なら、duplicate も別の行も送られない（その逆も）", async () => {
    st.resolve.mockRejectedValueOnce(new TypeError("network"));
    render().distinct(0)!.onClick!();
    await settle();
    let v = render();
    v.duplicate(0)!.onClick!();
    v.duplicate(1)!.onClick!();
    v.distinct(1)!.onClick!();
    await settle();
    expect(calls()).toBe(1);

    unmount();
    st.resolve.mockReset();
    st.resolve.mockRejectedValueOnce(new TypeError("network"));
    render().duplicate(1)!.onClick!();
    await settle();
    v = render();
    v.distinct(0)!.onClick!();
    v.distinct(1)!.onClick!();
    v.duplicate(0)!.onClick!();
    await settle();
    expect(calls()).toBe(1);
  });

  // 修正前に失敗: ロックが解けているので再送される
  it("props 更新（新しい items・明細が減る・0 件を経由）・再描画では解けず、案内も消えない", async () => {
    st.resolve.mockRejectedValue(new TypeError("network"));
    render().distinct(0)!.onClick!();
    await settle();
    expect(calls()).toBe(1);
    const variants: Partial<Props>[] = [
      { items: ITEMS.map((i) => ({ ...i })) },
      { items: ITEMS.filter((i) => i.id !== "D1") },
      { items: [] },
      { items: ITEMS },
      { canApprove: false },
      { canApprove: true },
    ];
    for (const next of variants) {
      const v = render(next);
      if (v.empty) continue; // 0 件の間は何も描かない（フックの状態は保持される）
      expect(v.message).toMatch(UNKNOWN);
      for (const r of v.rows) for (const b of [r.distinct, r.duplicate]) if (b) expect(b.disabled).toBe(true);
      await attemptEverything(v);
    }
    expect(calls()).toBe(1);
    expect(render().message).toMatch(UNKNOWN);
  });

  // 再マウントで回復するのは現状でも成り立つ（回復の仕様を固定する）
  it("実際の再マウント（再読み込み）で解除され、案内も消えて、次の操作が 1 回送られる", async () => {
    st.resolve.mockRejectedValueOnce(new TypeError("network"));
    render().distinct(0)!.onClick!();
    await settle();
    expect(render().message).toMatch(UNKNOWN);
    unmount();
    const v = render();
    expect(v.message).toBeNull();
    expectAllEnabled(v, 4);
    st.resolve.mockResolvedValue(OK);
    v.duplicate(1)!.onClick!();
    await settle();
    expect(calls()).toBe(2);
    expect(st.resolve.mock.calls[1]![1]).toMatchObject({ bankTransactionId: "D2", resolution: "duplicate" });
  });
});

describe("DuplicatesPanel の送信ガード: 確定した結果ではロックしない", () => {
  it("既知の拒否（ok: false）: 拒否の文が出て、ロックされず、意図した再試行は 1 回送られる", async () => {
    st.resolve.mockResolvedValueOnce({ ok: false, error: "この明細はすでに判断済みです" });
    render().distinct(0)!.onClick!();
    await settle();
    let v = render();
    expect(v.message).toBe("この明細はすでに判断済みです");
    expect(v.message).not.toMatch(UNKNOWN);
    expectAllEnabled(v, 4);
    st.resolve.mockResolvedValue(OK);
    v.duplicate(1)!.onClick!();
    await settle();
    expect(calls()).toBe(2);
    v = render();
    expect(v.message).toBeNull();
  });

  // 修正前に失敗: 送信中に反対の判断が送られる（拒否の後に解除する前提でも、解除までは相互排他）
  it("既知の拒否が返るまでの間は他の判断を送れず、返った後に解除される", async () => {
    const res = deferred<unknown>();
    st.resolve.mockReturnValueOnce(res.promise);
    const v = render();
    v.distinct(0)!.onClick!();
    v.duplicate(1)!.onClick!();
    await settle();
    expect(calls()).toBe(1);
    res.resolve({ ok: false, error: "対象の明細が見つかりません" });
    await settle();
    expectAllEnabled(render(), 4);
    expect(calls()).toBe(1);
  });

  it("成功（ok: true）: 案内なしでロックが解け、続けて別の明細・反対の判断も送れる", async () => {
    st.resolve.mockResolvedValue(OK);
    render().distinct(0)!.onClick!();
    await settle();
    let v = render();
    expect(v.message).toBeNull();
    expectAllEnabled(v, 4);
    v.duplicate(1)!.onClick!();
    await settle();
    v = render();
    expect(v.message).toBeNull();
    expectAllEnabled(v, 4);
    v.distinct(1)!.onClick!();
    await settle();
    expect(calls()).toBe(3);
  });

  it("既知の拒否のあとに結果不明が起きたら、そこからはロックする", async () => {
    st.resolve.mockResolvedValueOnce({ ok: false, error: "対象の明細が見つかりません" });
    st.resolve.mockRejectedValueOnce(new TypeError("network"));
    render().distinct(0)!.onClick!();
    await settle();
    render().distinct(1)!.onClick!();
    await settle();
    expect(calls()).toBe(2);
    const v = render();
    expect(v.message).toMatch(UNKNOWN);
    expectAllDisabled(v, 4);
    await attemptEverything(v);
    expect(calls()).toBe(2);
  });
});

// 実際の submitDuplicateResolution を、偽の Supabase rpc につないだ合成テスト（実 DB・Next は使わない）。
// 設計: docs/reviews/2026-11-05-duplicate-result-validation.md
describe("DuplicatesPanel + 実際の submitDuplicateResolution: 不正な成功結果は結果不明としてロックする", () => {
  const VALID_UUID = "00000000-0000-4000-8000-0000000000ee";
  // 実際の submitDuplicateResolution は bankTransactionId を uuid として検証する。上の ITEMS（"D1"/"D2"）では
  // 入力検証で止まって RPC に届かず、意図した応答の挙動を確かめられない。この節だけ架空の有効な UUID を使う
  const UUID_A = "00000000-0000-4000-8000-0000000000a1";
  const UUID_B = "00000000-0000-4000-8000-0000000000a2";
  const RPC_ITEMS = [dup(UUID_A, "2026-10-31", 1000, "振込 テスト商店A"), dup(UUID_B, "2026-10-30", 2000, "振込 テスト商店B")];
  type RpcCall = [string, Record<string, unknown>];

  beforeEach(() => {
    st.slots = [];
    st.index = 0;
    cur = { ...base(), items: RPC_ITEMS };
    render();
  });

  function wire(respond: (n: number) => { data: unknown; error: null }) {
    const rpcCalls: RpcCall[] = [];
    const client = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push([fn, args]);
        return respond(rpcCalls.length);
      },
    } as unknown as SupabaseClient;
    st.resolve.mockImplementation((_cid: string, input: DuplicateResolutionInput) => submitDuplicateResolution(client, input));
    return rpcCalls;
  }

  it.each([
    ["distinct", "duplicate"],
    ["duplicate", "distinct"],
  ] as const)("%s の応答が不正 → 案内が出て、反対の判断（%s）も他の行も、古いハンドラでも送られない", async (first, opposite) => {
    const rpcCalls = wire(() => ({ data: "not-a-uuid", error: null }));
    const initial = render();
    initial[first](0)!.onClick!();
    await settle();
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]![1]).toMatchObject({ p_bank_transaction_id: UUID_A, p_resolution: first });

    const v = render();
    expect(v.message).toMatch(UNKNOWN);
    expect(v.message).toMatch(RELOAD);
    expect(v.message).not.toMatch(/not-a-uuid/);
    expectAllDisabled(v, 4);
    v[opposite](0)!.onClick!();
    v[opposite](1)!.onClick!();
    v[first](1)!.onClick!();
    await attemptEverything(v);
    await attemptEverything(initial);
    expect(rpcCalls).toHaveLength(1);
    expect(render().message).toMatch(UNKNOWN);
  });

  // Vitest は [] を「引数なし」として展開し undefined になるため、{ data } に包んで実際の値を渡す
  it.each([null, undefined, "", "   ", 123, true, [], {}].map((data) => ({ data })))("不正な応答 $data でも同様にロックされる", async ({ data }) => {
    const rpcCalls = wire(() => ({ data, error: null }));
    render().duplicate(1)!.onClick!();
    await settle();
    const v = render();
    expect(v.message).toMatch(UNKNOWN);
    expectAllDisabled(v, 4);
    await attemptEverything(v);
    expect(rpcCalls).toHaveLength(1);
  });

  it("正しい UUID の応答 → 案内なしでロックされず、続けて反対の判断・別の行も 1 回ずつ送れる", async () => {
    const rpcCalls = wire(() => ({ data: VALID_UUID, error: null }));
    render().distinct(0)!.onClick!();
    await settle();
    let v = render();
    expect(v.message).toBeNull();
    expectAllEnabled(v, 4);
    v.duplicate(1)!.onClick!();
    await settle();
    v = render();
    expect(v.message).toBeNull();
    expectAllEnabled(v, 4);
    expect(rpcCalls.map(([fn, a]) => [fn, a["p_bank_transaction_id"], a["p_resolution"]])).toEqual([
      ["resolve_suspected_duplicate", UUID_A, "distinct"],
      ["resolve_suspected_duplicate", UUID_B, "duplicate"],
    ]);
  });

  it("不正な応答のあと、再マウント（再読み込み）後に正しい UUID が返れば再開できる", async () => {
    const rpcCalls = wire((n) => ({ data: n === 1 ? "" : VALID_UUID, error: null }));
    render().distinct(0)!.onClick!();
    await settle();
    expect(render().message).toMatch(UNKNOWN);
    unmount();
    const v = render();
    expect(v.message).toBeNull();
    expectAllEnabled(v, 4);
    v.duplicate(1)!.onClick!();
    await settle();
    expect(rpcCalls).toHaveLength(2);
    expect(render().message).toBeNull();
  });
});

describe("DuplicatesPanel の送信ガード: 役割（担当者は除外できない）", () => {
  it("担当者（canApprove=false）: 「別の取引」は送れて、「重複として除外」は表示されない", async () => {
    st.resolve.mockResolvedValue(OK);
    const v = render({ canApprove: false });
    expect(v.rows.map((r) => r.duplicate)).toEqual([undefined, undefined]);
    v.distinct(0)!.onClick!();
    await settle();
    expect(st.resolve).toHaveBeenCalledTimes(1);
    expect(st.resolve).toHaveBeenCalledWith(CID, { bankTransactionId: "D1", resolution: "distinct", reason: null });
  });

  // 修正前に失敗: 古いハンドラ（承認者の描画のもの）が canApprove=false の後でも除外を送る
  it("承認者の描画の「除外」ハンドラは、canApprove=false に変わった後に呼んでも送られない", async () => {
    st.resolve.mockResolvedValue(OK);
    const stale = render({ canApprove: true });
    const staleDuplicate = stale.duplicate(0)!.onClick!;
    const staleDuplicate2 = stale.duplicate(1)!.onClick!;
    const v = render({ canApprove: false });
    expect(v.duplicate(0)).toBeUndefined();
    staleDuplicate();
    staleDuplicate2();
    await settle();
    expect(calls()).toBe(0);
  });

  // 修正前に失敗: 拒否したのに送られる。さらに、拒否はガードを掴まず、案内もロックも作らない
  it("担当者への拒否はロックを作らない: 古い除外ハンドラの後でも「別の取引」は 1 回送れる", async () => {
    st.resolve.mockResolvedValue(OK);
    const stale = render({ canApprove: true }).duplicate(0)!.onClick!;
    render({ canApprove: false });
    stale();
    await settle();
    expect(calls()).toBe(0);
    const v = render();
    expect(v.message).toBeNull();
    expectAllEnabled(v, 2);
    v.distinct(0)!.onClick!();
    await settle();
    expect(calls()).toBe(1);
    expect(st.resolve.mock.calls[0]![1]).toMatchObject({ resolution: "distinct" });
  });

  // 修正前に失敗: 結果不明のあと担当者でも distinct を再送できる
  it("担当者でも結果不明のあとは「別の取引」を再送できない", async () => {
    st.resolve.mockRejectedValue(new TypeError("network"));
    const first = render({ canApprove: false });
    first.distinct(0)!.onClick!();
    await settle();
    const v = render();
    expect(v.message).toMatch(UNKNOWN);
    expectAllDisabled(v, 2);
    v.distinct(0)!.onClick!();
    v.distinct(1)!.onClick!();
    first.distinct(1)!.onClick!();
    await settle();
    expect(calls()).toBe(1);
  });
});
