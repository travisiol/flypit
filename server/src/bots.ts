import { RULES } from "../../web/src/shared/rules";
import { Bots as SharedBots } from "../../web/src/shared/bots";
import type { World } from "../../web/src/shared/sim";
import { drawPot } from "./db";
import { config } from "./config";

/**
 * The shared bot brain, staked from the pot: a bot spawns with
 * `botStakeCoins` if the pot can pay them, with nothing otherwise. Pot
 * coins on a bot are still pot coins — they go back to the pot on a
 * restart and can never leave through a bot.
 */
export class Bots extends SharedBots {
  constructor(world: World) {
    super(world, {
      count: config.botCount,
      stake: () => (drawPot(RULES.botStakeCoins) ? RULES.botStakeCoins : 0),
    });
  }
}
