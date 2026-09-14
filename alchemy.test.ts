/**
 * Docker test fixtures as an alchemy Stack. `nub run test:docker` deploys
 * this, runs the client against each container, and destroys it. Kept as
 * a Stack (not hand-rolled `docker run`) so the containers get alchemy's
 * lifecycle: named resources, a reviewable diff, and one teardown that
 * removes exactly what it created.
 *
 * `Docker.Container` accepts `external: 0` to publish on an ephemeral
 * host port; the bound port is read back from `container.ports`.
 */
import * as Alchemy from "alchemy";
import * as Docker from "alchemy/Docker";
import * as Effect from "effect/Effect";

export interface FixturePorts {
  readonly mailpitSmtp: number;
  readonly mailpitHttp: number;
  readonly smtp4devSmtp: number;
}

export default Alchemy.Stack(
  "effect-smtp-test-fixtures",
  {
    providers: Docker.providers(),
    state: Alchemy.localState(".alchemy/test-state"),
  },
  Effect.gen(function* () {
    const network = yield* Docker.Network("test-net");

    const mailpitImage = yield* Docker.RemoteImage("mailpit-image", {
      name: "axllent/mailpit",
      tag: "latest",
      alwaysPull: false,
    });
    const mailpit = yield* Docker.Container("mailpit", {
      name: "effect-smtp-alchemy-mailpit",
      image: mailpitImage,
      networks: [{ name: network.name, aliases: ["mailpit"] }],
      ports: [
        { external: 0, internal: 1025 },
        { external: 0, internal: 8025 },
      ],
      start: true,
    });

    const smtp4devImage = yield* Docker.RemoteImage("smtp4dev-image", {
      name: "rnwood/smtp4dev",
      tag: "latest",
      alwaysPull: false,
    });
    const smtp4dev = yield* Docker.Container("smtp4dev", {
      name: "effect-smtp-alchemy-smtp4dev",
      image: smtp4devImage,
      networks: [{ name: network.name, aliases: ["smtp4dev"] }],
      ports: [{ external: 0, internal: 25 }],
      start: true,
    });

    return {
      mailpitSmtp: mailpit.ports["1025/tcp"] ?? 0,
      mailpitHttp: mailpit.ports["8025/tcp"] ?? 0,
      smtp4devSmtp: smtp4dev.ports["25/tcp"] ?? 0,
    } satisfies FixturePorts;
  }),
);
