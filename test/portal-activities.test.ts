import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PortalError } from "../src/domain/errors.ts";
import { PortalService } from "../src/index.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const reply = (body: unknown, status = 200) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
};

const activity = {
  idAtividade: 1,
  idCliente: 3552502,
  codigo: "0109",
  descricao: "Programação",
  codigoServico: "1.09",
  aliquota: 2,
};

describe("PortalService.listActivities — resposta inválida", () => {
  it("lista válida continua funcionando", async () => {
    reply({ codigoHTTP: 200, conteudo: [activity] });
    const [first] = await PortalService.listActivities("3552502");
    assert.equal(first?.code, "0109");
  });

  it("conteudo ausente lança, em vez de devolver []", async () => {
    reply({ codigoHTTP: 200 });
    await assert.rejects(PortalService.listActivities("3552502"), (error) => {
      assert.ok(error instanceof PortalError);
      assert.equal(error.code, "UNEXPECTED_RESPONSE");
      assert.equal(error.retryable, false);
      return true;
    });
  });

  it("conteudo que não é lista lança", async () => {
    reply({ codigoHTTP: 200, conteudo: { erro: "x" } });
    await assert.rejects(PortalService.listActivities("3552502"), PortalError);
    reply({ codigoHTTP: 200, conteudo: null });
    await assert.rejects(PortalService.listActivities("3552502"), PortalError);
  });

  it("sucesso === false lança com a mensagem do portal, mesmo com lista", async () => {
    reply({ codigoHTTP: 200, sucesso: false, mensagem: "Cliente inválido", conteudo: [activity] });
    await assert.rejects(PortalService.listActivities("3552502"), /Cliente inválido/);
  });

  it("corpo que não é JSON lança", async () => {
    globalThis.fetch = (async () => new Response("<html>manutenção</html>", { status: 200 })) as typeof fetch;
    await assert.rejects(PortalService.listActivities("3552502"), PortalError);
  });
});

describe("PortalService#companyActivities — resposta inválida", () => {
  /** Sessão já aberta: o login responde na ordem, depois vem a rota testada. */
  async function session(activitiesBody: unknown): Promise<PortalService> {
    const token = `x.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.y`;
    const answers: unknown[] = [
      { access_token: token, codigo_usuario: "U1" },
      {
        conteudo: {
          codigoUsuario: "U1",
          empresas: [
            {
              documento: "37969249000110",
              razaoSocial: "EMPRESA TESTE LTDA",
              inscricaoMunicipal: "53624",
              idEmpresa: 7,
              idCliente: 3552502,
              clienteReferencia: "ref",
              tipoEmpresa: 1,
            },
          ],
        },
      },
      { access_token: token },
      activitiesBody,
    ];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(answers.shift()), {
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    return PortalService.authenticate({ login: "12345678909", password: "x", cityCode: "3552502" });
  }

  it("lista válida continua funcionando", async () => {
    const portal = await session({ codigoHTTP: 200, conteudo: [activity] });
    assert.equal((await portal.companyActivities("2026-11-01")).length, 1);
  });

  it("conteudo ausente ou sucesso === false lança", async () => {
    await assert.rejects((await session({ codigoHTTP: 200 })).companyActivities(), PortalError);
    await assert.rejects(
      (await session({ sucesso: false, mensagem: "Empresa sem enquadramento", conteudo: [] })).companyActivities(),
      /Empresa sem enquadramento/,
    );
  });
});
