import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Server } from "node:net";
import { after, before, describe, it } from "node:test";
import { NfseClient } from "../src/index.ts";
import { createXmlSigner } from "../src/infra/xml-signer.ts";
import { NfscService } from "../src/providers/giss/nfsc-service.ts";
import { NfseService } from "../src/providers/giss/nfse-service.ts";
import type { callSoap } from "../src/providers/giss/soap-client.ts";
import { PROVIDER_CNPJ, testCertificate, testPfx } from "./helpers.ts";

const PERIOD = { issuePeriod: { from: "2026-11-01", to: "2026-11-30" } };
const PURCHASED = { ...PERIOD, competencePeriod: { from: "2026-11-01" }, declaredNumber: 1, declaredSeries: "A" };

describe("timeoutMs do SOAP", () => {
  // aceita a conexão e nunca responde — nem o handshake TLS
  const silent: Server = createServer(() => {});
  let host = "";

  before(async () => {
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    host = `https://127.0.0.1:${(silent.address() as AddressInfo).port}`;
  });
  after(() => {
    silent.close();
  });

  const client = (timeoutMs?: number) =>
    new NfseClient({
      environment: "producao",
      city: "suzano",
      cnpj: PROVIDER_CNPJ,
      municipalRegistration: "53624",
      host,
      certificate: testPfx("segredo"),
      certificatePassword: "segredo",
      ...(timeoutMs !== undefined && { timeoutMs }),
    });

  it("NfseClient repassa timeoutMs ao serviço nfse", { timeout: 5000 }, async () => {
    const started = Date.now();
    await assert.rejects(client(150).nfse.queryProvidedServices(PERIOD), /timeout|tempo|timed out/i);
    assert.ok(Date.now() - started < 4000);
  });

  it("NfseClient repassa timeoutMs ao serviço nfsc", { timeout: 5000 }, async () => {
    const started = Date.now();
    await assert.rejects(client(150).nfsc.queryPurchasedByNumber(PURCHASED), /timeout|tempo|timed out/i);
    assert.ok(Date.now() - started < 4000);
  });

  describe("chegada ao transporte", () => {
    const certificate = testCertificate();
    const seen: Array<number | undefined> = [];
    const transport: typeof callSoap = async (_operation, _request, options) => {
      seen.push(options.timeoutMs);
      throw new Error("stop");
    };
    const base = { host: "https://127.0.0.1:1", certificate, signer: createXmlSigner(certificate), cityCode: "3552502", transport };

    it("nfse e nfsc passam timeoutMs; sem a opção, nada é enviado e vale o padrão", async () => {
      seen.length = 0;
      const nfse = (timeoutMs?: number) =>
        new NfseService({ ...base, provider: { cnpj: PROVIDER_CNPJ, municipalRegistration: "53624" } as never, version: "2.04", ...(timeoutMs !== undefined && { timeoutMs }) });
      const nfsc = (timeoutMs?: number) =>
        new NfscService({ ...base, taker: { cnpj: PROVIDER_CNPJ, municipalRegistration: "53624" } as never, ...(timeoutMs !== undefined && { timeoutMs }) });

      await nfse(1234).queryProvidedServices(PERIOD).catch(() => {});
      await nfsc(5678).queryPurchasedByNumber(PURCHASED).catch(() => {});
      await nfse().queryProvidedServices(PERIOD).catch(() => {});
      await nfsc().queryPurchasedByNumber(PURCHASED).catch(() => {});
      assert.deepEqual(seen, [1234, 5678, undefined, undefined]);
    });
  });
});
