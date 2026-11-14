import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";
import { TransportError } from "../src/domain/errors.ts";
import { NfseClient, PortalService } from "../src/index.ts";
import { PORTAL_TIMEOUT_MS, requestBinary, requestJson } from "../src/providers/giss/http-client.ts";
import { callSoap } from "../src/providers/giss/soap-client.ts";
import { PROVIDER_CNPJ, testCertificate, testPfx } from "./helpers.ts";

/** Servidor que aceita a conexão e nunca responde. */
const silent = createTcpServer(() => {});
const hang = createHttpServer(() => {
  // recebe a requisição e nunca responde
});
let silentPort = 0;
let hangBase = "";

before(async () => {
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  silentPort = (silent.address() as AddressInfo).port;
  await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", resolve));
  hangBase = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
});
after(() => {
  silent.close();
  hang.closeAllConnections();
  hang.close();
});

const timedOut = (error: unknown) =>
  error instanceof TransportError && error.details["errno"] === "ETIMEDOUT" && /200ms/.test(error.message);

describe("timeout configurável", () => {
  it("o padrão do portal continua 60 s", () => {
    assert.equal(PORTAL_TIMEOUT_MS, 60_000);
  });

  it("requestJson respeita o limite informado", async () => {
    const started = Date.now();
    await assert.rejects(requestJson(hangBase, "/x", {}, 200), timedOut);
    assert.ok(Date.now() - started < 5_000);
  });

  it("requestBinary respeita o limite informado", async () => {
    await assert.rejects(requestBinary(hangBase, "/x", {}, "application/pdf", 200), timedOut);
  });

  it("callSoap respeita timeoutMs", async () => {
    await assert.rejects(
      callSoap("ConsultarNfsePorRps", "<x/>", {
        host: `https://127.0.0.1:${silentPort}`,
        service: "nfse",
        certificate: testCertificate(),
        timeoutMs: 200,
      }),
      timedOut,
    );
  });

  describe("PortalService", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    /** `fetch` que não responde até o sinal abortar, como um portal travado. */
    const stalledFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });

    it("listActivities repassa o limite", async () => {
      globalThis.fetch = stalledFetch;
      await assert.rejects(PortalService.listActivities("3552502", undefined, 200), timedOut);
    });

    it("authenticate repassa o limite a cada passo do login", async () => {
      globalThis.fetch = stalledFetch;
      await assert.rejects(
        PortalService.authenticate({ login: "12345678909", password: "x", cityCode: "3552502", timeoutMs: 200 }),
        timedOut,
      );
    });

    it("sem limite informado, o fetch recebe o sinal de 60 s", async () => {
      let seen: AbortSignal | undefined;
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return new Response('{"conteudo":[]}', { headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;
      await PortalService.listActivities("3552502");
      assert.ok(seen && !seen.aborted);
    });
  });

  describe("NfseClient", () => {
    const client = (host: string, timeoutMs?: number) =>
      new NfseClient({
        environment: "producao",
        city: "suzano",
        host,
        cnpj: PROVIDER_CNPJ,
        municipalRegistration: "53624",
        certificate: testPfx("segredo"),
        certificatePassword: "segredo",
        timeoutMs,
      });

    it("repassa timeoutMs ao SOAP do nfse", async () => {
      await assert.rejects(
        client(`https://127.0.0.1:${silentPort}`, 200).nfse.queryNfseByRps({ number: "1", series: "A" }),
        timedOut,
      );
    });

    it("repassa timeoutMs ao SOAP do nfsc", async () => {
      await assert.rejects(
        client(`https://127.0.0.1:${silentPort}`, 200).nfsc.queryPurchasedByProtocol("P-1"),
        timedOut,
      );
    });
  });
});
