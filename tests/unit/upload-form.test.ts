import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UPLOAD_UNKNOWN_MESSAGE } from "@/lib/statements/upload-result";

// 実際の UploadForm / onSubmit を、最小の hook 実装（useState / useRef だけ）で動かす。
// 再描画は render() を呼んだときだけ起きる。呼ぶ前の onSubmit は「再描画前に届いた古いハンドラ」を表す。
// DOM・ブラウザ・ファイル選択ダイアログは通らない（合成テスト）。
const h = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    events: [] as string[],
    refresh: (() => {}) as () => void,
  };
  return state;
});

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return {
    ...actual,
    useState: <T>(init: T) => {
      const i = h.index++;
      if (!(i in h.slots)) h.slots[i] = { value: init };
      const slot = h.slots[i] as { value: T };
      const set = (v: T | ((p: T) => T)) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(slot.value) : v;
        h.events.push(`set#${i}:${String(next)}`);
        slot.value = next;
      };
      return [slot.value, set] as const;
    },
    useRef: <T>(init: T) => {
      const i = h.index++;
      if (!(i in h.slots)) h.slots[i] = { current: init };
      return h.slots[i] as { current: T };
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => h.refresh() }) }));
// UploadForm を直接呼ぶと Link は実行されず、type が next/link の default（このモック）の要素のまま返る。
// そのため要素の type を、取り込んだモックの同一性で判定する。
vi.mock("next/link", () => ({
  default: function MockLink(p: { href: string; children?: unknown }) {
    return createElement("a", { href: p.href }, p.children as never);
  },
}));

import Link from "next/link";
import { UploadForm } from "@/app/customers/[customerId]/upload-form";

const CID = "11111111-1111-4111-8111-111111111111";
const props = {
  customerId: CID,
  wallets: [{ id: "w-1", name: "普通預金" }],
  formats: [{ id: "bank_generic", label: "銀行" }],
};

type El = { type: unknown; props: Record<string, unknown> };
const isEl = (n: unknown): n is El => typeof n === "object" && n !== null && "props" in n;
const walk = (n: unknown, out: El[] = []): El[] => {
  if (Array.isArray(n)) n.forEach((c) => walk(c, out));
  else if (isEl(n)) {
    out.push(n);
    walk(n.props.children, out);
  }
  return out;
};
const textOf = (n: unknown): string =>
  Array.isArray(n) ? n.map(textOf).join("") : isEl(n) ? textOf(n.props.children) : typeof n === "string" ? n : "";

/** useState / useRef の枠を保ったまま UploadForm を呼び直す（= 再描画）。slots を空にすると再マウント */
function render() {
  h.index = 0;
  const root = UploadForm(props) as unknown as ReactNode;
  const els = walk(root);
  const by = (pred: (e: El) => boolean) => {
    const e = els.find(pred);
    if (!e) throw new Error("element not found");
    return e;
  };
  const form = by((e) => e.type === "form");
  return {
    onSubmit: form.props.onSubmit as (ev: unknown) => Promise<void>,
    wallet: by((e) => e.props.name === "walletId").props,
    format: by((e) => e.props.name === "formatId").props,
    file: by((e) => e.props.name === "file").props,
    submit: by((e) => e.type === "button").props,
    hrefs: els.filter((e) => e.type === Link).map((e) => e.props.href),
    notes: els.filter((e) => e.props.className === "note").map((e) => textOf(e)),
  };
}
const controlsDisabled = (v: ReturnType<typeof render>) => [v.wallet, v.format, v.file, v.submit].map((p) => Boolean(p.disabled));

// 画面上の現在値。FormData のスタブが構築時点の内容だけを写す（無効化後に構築すれば入らない状況を events で検証する）
const formValues = { walletId: "w-1", formatId: "bank_generic", file: "oct.csv" };
const snapshots: Record<string, string>[] = [];
class FakeFormData {
  fields: Record<string, string>;
  constructor(form: unknown) {
    if (form === "THROW") throw new TypeError("form unreadable");
    h.events.push("snapshot");
    this.fields = { ...formValues };
    snapshots.push(this.fields);
  }
}
const makeEvent = (target: unknown = {}) => ({ preventDefault: vi.fn(), currentTarget: target });

const body = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });
const SUCCESS = {
  ok: true,
  importId: "22222222-2222-4222-8222-222222222222",
  insertedCount: 2,
  skippedDuplicateCount: 1,
  suspectedDuplicateCount: 1,
  ignoredCount: 0,
  incomeTotal: 10000,
  expenseTotal: 3000,
  insertedAmountTotal: 8000,
  skippedAmountTotal: 2000,
  suspectedAmountTotal: 3000,
};
const REJECTED = { ok: false, errors: [{ line: 7, message: "日付を読めません" }], failureRecordId: null };

const fetchMock = vi.fn();
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  h.slots = [];
  h.index = 0;
  h.events = [];
  h.refresh = () => {};
  snapshots.length = 0;
  Object.assign(formValues, { walletId: "w-1", formatId: "bank_generic", file: "oct.csv" });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("FormData", FakeFormData);
});

const LINKS = [`/customers/${CID}/imports`, `/customers/${CID}/statements`];

describe("明細CSVアップロード欄の送信ガード", () => {
  it("初期表示: 口座・形式・ファイル・送信ボタンは有効で、記録と一覧へのリンクがある", () => {
    const v = render();
    expect(controlsDisabled(v)).toEqual([false, false, false, false]);
    expect(v.hrefs).toEqual(LINKS);
    expect(v.notes).toEqual([]);
  });

  it("再描画前に onSubmit が繰り返し呼ばれても、取得も送信も1回だけ（2回目以降は preventDefault のみ）", async () => {
    const res = deferred<Response>();
    fetchMock.mockReturnValue(res.promise);
    const v = render(); // 同じ古いハンドラを再描画なしで呼ぶ
    const evs = [makeEvent(), makeEvent(), makeEvent()];
    const calls = evs.map((e) => v.onSubmit(e));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveLength(1);
    for (const e of evs) expect(e.preventDefault).toHaveBeenCalledTimes(1);
    res.resolve(body(200, SUCCESS));
    await Promise.all(calls);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("送信内容は無効化より前に取得し、送信中の編集は送信内容に影響せず、描画後は全コントロールが無効", async () => {
    const res = deferred<Response>();
    fetchMock.mockReturnValue(res.promise);
    const v = render();
    const done = v.onSubmit(makeEvent());
    // 取得 → busy 化の順（無効化が描画される前に FormData を読む）
    expect(h.events[0]).toBe("snapshot");
    expect(h.events).toContain("set#1:true"); // slot 1 = busy
    expect(h.events.indexOf("snapshot")).toBeLessThan(h.events.indexOf("set#1:true"));
    formValues.walletId = "w-edited"; // 送信中に値を変えても
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: FakeFormData }];
    expect(url).toBe(`/api/customers/${CID}/statements`);
    expect(init.method).toBe("POST");
    expect(init.body.fields).toEqual({ walletId: "w-1", formatId: "bank_generic", file: "oct.csv" });
    expect(controlsDisabled(render())).toEqual([true, true, true, true]);
    res.resolve(body(200, SUCCESS));
    await done;
  });

  it("成功: 要約を出し、更新を1回呼び、コントロールを有効に戻して次の取込ができる。リンクは残る", async () => {
    const refresh = vi.fn();
    h.refresh = refresh;
    fetchMock.mockResolvedValue(body(200, SUCCESS));
    await render().onSubmit(makeEvent());
    const v = render();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(controlsDisabled(v)).toEqual([false, false, false, false]);
    expect(v.notes.join("")).toContain("登録 2件 8,000円");
    expect(v.notes.join("")).not.toContain("再送できません");
    expect(v.hrefs).toEqual(LINKS);
    fetchMock.mockResolvedValue(body(200, SUCCESS));
    await v.onSubmit(makeEvent());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("拒否（登録していないと確認できた）: 有効に戻り、直して再送でき、前の拒否文は送信中に消える", async () => {
    fetchMock.mockResolvedValueOnce(body(422, REJECTED));
    await render().onSubmit(makeEvent());
    let v = render();
    expect(controlsDisabled(v)).toEqual([false, false, false, false]);
    expect(v.notes.join("")).toContain("明細は1件も登録していません");
    expect(v.notes.join("")).toContain("7行目 日付を読めません");
    expect(v.hrefs).toEqual(LINKS);
    formValues.file = "fixed.csv";
    const retry = deferred<Response>();
    fetchMock.mockReturnValueOnce(retry.promise);
    const pending = v.onSubmit(makeEvent());
    // 再送の応答待ち: 前の拒否文は消え、全コントロールが無効
    v = render();
    expect(v.notes).toEqual([]);
    expect(controlsDisabled(v)).toEqual([true, true, true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(snapshots[1]?.file).toBe("fixed.csv");
    retry.resolve(body(200, SUCCESS));
    await pending;
    v = render();
    expect(controlsDisabled(v)).toEqual([false, false, false, false]);
    expect(v.notes.join("")).toContain("登録 2件");
    expect(v.notes.join("")).not.toContain("日付を読めません");
  });

  it("結果不明（5xx）: 全コントロールが無効のまま固定され、再描画しても再送できず、明示の案内とリンクが出る", async () => {
    fetchMock.mockResolvedValue(body(500, { error: "boom" }));
    const stale = render().onSubmit;
    await stale(makeEvent());
    for (let i = 0; i < 3; i++) {
      const v = render(); // 再描画を重ねても固定は解けない
      expect(controlsDisabled(v)).toEqual([true, true, true, true]);
      expect(v.notes).toContain(UPLOAD_UNKNOWN_MESSAGE);
      expect(v.notes.join("")).toContain("この画面からは再送できません");
      expect(v.notes.join("")).toContain("再読み込み");
      expect(v.hrefs).toEqual(LINKS);
      const e = makeEvent();
      await v.onSubmit(e); // 無効化を迂回した直接の呼出しも送らない
      expect(e.preventDefault).toHaveBeenCalledTimes(1);
    }
    await stale(makeEvent()); // 古いハンドラでも同じ
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveLength(1);
  });

  it("結果不明のあとに router.refresh が成功しても、また例外でも、固定は解けず、拒否・登録済みとは言い換えない", async () => {
    for (const refresh of [vi.fn(), vi.fn(() => { throw new Error("refresh failed"); })]) {
      h.slots = [];
      fetchMock.mockReset();
      fetchMock.mockRejectedValue(new TypeError("network"));
      h.refresh = refresh;
      await render().onSubmit(makeEvent());
      expect(refresh).toHaveBeenCalledTimes(1);
      const v = render();
      expect(controlsDisabled(v)).toEqual([true, true, true, true]);
      expect(v.notes).toContain(UPLOAD_UNKNOWN_MESSAGE);
      expect(v.notes.join("")).not.toContain("更新に失敗");
      await v.onSubmit(makeEvent());
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("合計と内訳が食い違う HTTP 200 は結果不明として固定し、refresh が成功しても解除せず、再送しない", async () => {
    const refresh = vi.fn();
    h.refresh = refresh;
    fetchMock.mockResolvedValue(body(200, { ...SUCCESS, suspectedAmountTotal: 2999 }));
    await render().onSubmit(makeEvent());
    expect(refresh).toHaveBeenCalledTimes(1);
    const v = render();
    expect(controlsDisabled(v)).toEqual([true, true, true, true]);
    expect(v.notes).toContain(UPLOAD_UNKNOWN_MESSAGE);
    expect(v.notes.join("")).not.toContain("読めた行");
    await v.onSubmit(makeEvent());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("想定外の例外（フォーム読取の失敗）は結果不明として固定し、送信しない。再マウントで解除される", async () => {
    await render().onSubmit(makeEvent("THROW"));
    expect(fetchMock).not.toHaveBeenCalled();
    let v = render();
    expect(controlsDisabled(v)).toEqual([true, true, true, true]);
    expect(v.notes).toContain(UPLOAD_UNKNOWN_MESSAGE);
    expect(v.hrefs).toEqual(LINKS);
    await v.onSubmit(makeEvent());
    expect(fetchMock).not.toHaveBeenCalled();
    h.slots = []; // ページの再読み込み（再マウント）
    v = render();
    expect(controlsDisabled(v)).toEqual([false, false, false, false]);
    fetchMock.mockResolvedValue(body(200, SUCCESS));
    await v.onSubmit(makeEvent());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("成功後に router.refresh が例外でも、成功の要約を残して更新失敗を足すだけで、未登録とは言わず、固定もしない", async () => {
    h.refresh = () => {
      throw new Error("refresh failed");
    };
    fetchMock.mockResolvedValue(body(200, SUCCESS));
    await render().onSubmit(makeEvent());
    const v = render();
    const text = v.notes.join("");
    expect(text).toContain("登録 2件 8,000円");
    expect(text).toContain("更新に失敗しました");
    expect(text).not.toMatch(/1件も登録していません|登録されていません/);
    expect(controlsDisabled(v)).toEqual([false, false, false, false]);
  });

  it("拒否後に router.refresh が例外でも、拒否の文言は変えず更新失敗を足すだけで、再送はできる", async () => {
    h.refresh = () => {
      throw new Error("refresh failed");
    };
    fetchMock.mockResolvedValue(body(422, REJECTED));
    await render().onSubmit(makeEvent());
    const v = render();
    expect(v.notes.join("")).toContain("明細は1件も登録していません");
    expect(v.notes.join("")).toContain("更新に失敗しました");
    expect(controlsDisabled(v)).toEqual([false, false, false, false]);
    await v.onSubmit(makeEvent());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
