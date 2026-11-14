import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { SoapFaultError, TransportError } from "../src/domain/errors.ts";
import { NfseClient } from "../src/index.ts";
import { createXmlSigner } from "../src/infra/xml-signer.ts";
import { NfscService } from "../src/providers/giss/nfsc-service.ts";
import { NfseService } from "../src/providers/giss/nfse-service.ts";
import { readSoapResponse, type SoapExchangeHook } from "../src/providers/giss/soap-client.ts";
import { fakeSoap, responses } from "./giss-fixtures.ts";
import { PROVIDER_CNPJ, SUZANO, testCertificate, testPfx } from "./helpers.ts";

const provider = { cnpj: PROVIDER_CNPJ, municipalRegistration: "53624" };
const envelope = (inner: string) =>
  `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;

type Exchange = { operation: string; signed: string; response: string | undefined };

function recorder() {
  const exchanges: Exchange[] = [];
  const onExchange: SoapExchangeHook = (operation, signed, response) => {
    exchanges.push({ operation, signed, response });
  };
  return { exchanges, onExchange };
}

function nfseWith(transport: ConstructorParameters<typeof NfseService>[0]["transport"], onExchange?: SoapExchangeHook) {
  const certificate = testCertificate();
  return new NfseService({
    host: "https://ws-teste.giss.com.br",
    certificate,
    signer: createXmlSigner(certificate),
    provider,
    cityCode: SUZANO,
    version: "2.04",
    transport,
    onExchange,
  });
}

describe("onExchange — hook de troca SOAP", () => {
  it("entrega o envio assinado e o retorno bruto de uma chamada que deu certo", async () => {
    const soap = fakeSoap({
      ConsultarNfsePorRps: () => responses.byRps({ number: "580", rps: { number: "42", series: "A" } }),
    });
    const { exchanges, onExchange } = recorder();
    const nfse = nfseWith(async (operation, xml, options) => {
      const response = await soap.transport(operation, xml, options);
      return { ...response, envelope: envelope("<outputXML>raw</outputXML>") };
    }, onExchange);

    await nfse.queryNfseByRps({ number: "42", series: "A" });

    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0]!.operation, "ConsultarNfsePorRps");
    assert.equal(exchanges[0]!.signed, soap.calls[0]!.xml);
    assert.match(exchanges[0]!.signed, /<Signature /);
    assert.equal(exchanges[0]!.response, envelope("<outputXML>raw</outputXML>"));
  });

  it("em fault, entrega o envelope que o SoapFaultError carrega", async () => {
    const fault = envelope("<soap:Fault><faultstring>schema</faultstring></soap:Fault>");
    const { exchanges, onExchange } = recorder();
    const nfse = nfseWith(async (operation) => {
      readSoapResponse(operation, 500, fault);
      throw new Error("unreachable");
    }, onExchange);

    await assert.rejects(nfse.queryNfseByRps({ number: "42", series: "A" }), (error) => {
      assert.ok(error instanceof SoapFaultError);
      assert.equal(error.envelope, fault);
      return true;
    });
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0]!.response, fault);
  });

  it("resposta sem outputXML e sem fault também guarda o envelope", () => {
    assert.throws(
      () => readSoapResponse("GerarNfse", 200, "<html/>"),
      (error) => error instanceof SoapFaultError && error.envelope === "<html/>",
    );
  });

  it("503 com HTML: o retorno bruto vai em details.envelope", () => {
    assert.throws(
      () => readSoapResponse("GerarNfse", 503, "<html>down</html>"),
      (error) => (error as TransportError).details["envelope"] === "<html>down</html>",
    );
  });

  it("em erro de rede, entrega `undefined` no lugar da resposta", async () => {
    const { exchanges, onExchange } = recorder();
    const nfse = nfseWith(async () => {
      throw new TransportError("caiu", { outcomeUnknown: true });
    }, onExchange);

    await assert.rejects(nfse.queryNfseByRps({ number: "42", series: "A" }), TransportError);
    assert.equal(exchanges.length, 1);
    assert.match(exchanges[0]!.signed, /<Signature /);
    assert.equal(exchanges[0]!.response, undefined);
  });

  it("um hook que lança não muda o resultado da chamada", async () => {
    const soap = fakeSoap({ ConsultarNfsePorRps: () => responses.byRps({ number: "580" }) });
    const nfse = nfseWith(soap.transport, () => {
      throw new Error("gravador fora do ar");
    });
    const { invoices } = await nfse.queryNfseByRps({ number: "42", series: "A" });
    assert.equal(invoices[0]?.number, "580");
  });

  it("sem o hook, nada muda", async () => {
    const soap = fakeSoap({ ConsultarNfsePorRps: () => responses.byRps({ number: "580" }) });
    const { invoices } = await nfseWith(soap.transport).queryNfseByRps({ number: "42", series: "A" });
    assert.equal(invoices[0]?.number, "580");
  });

  it("o nfsc também reporta a troca", async () => {
    const certificate = testCertificate();
    const { exchanges, onExchange } = recorder();
    const nfsc = new NfscService({
      host: "https://ws-teste.giss.com.br",
      certificate,
      signer: createXmlSigner(certificate),
      taker: provider,
      cityCode: SUZANO,
      transport: async () => {
        throw new TransportError("caiu");
      },
      onExchange,
    });
    await assert.rejects(nfsc.queryPurchasedByProtocol("T-1"), TransportError);
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0]!.response, undefined);
  });
});

describe("NfseClient — onExchange", () => {
  it("repassa o hook ao nfse: chamada real a uma porta fechada reporta `undefined`", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise((resolve) => probe.close(resolve));

    const { exchanges, onExchange } = recorder();
    const client = new NfseClient({
      environment: "producao",
      city: "suzano",
      host: `https://127.0.0.1:${port}`,
      cnpj: PROVIDER_CNPJ,
      municipalRegistration: "53624",
      certificate: testPfx("segredo"),
      certificatePassword: "segredo",
      onExchange,
    });

    await assert.rejects(client.nfse.queryNfseByRps({ number: "42", series: "A" }), TransportError);
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0]!.operation, "ConsultarNfsePorRps");
    assert.match(exchanges[0]!.signed, /<ConsultarNfseRpsEnvio/);
    assert.equal(exchanges[0]!.response, undefined);
  });
});
