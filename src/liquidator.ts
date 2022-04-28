import * as os from 'os';
import * as fs from 'fs';
import {
  AssetType,
  getMultipleAccounts,
  EntropyAccount,
  EntropyGroup,
  PerpMarket,
  RootBank,
  zeroKey,
  ZERO_BN,
  AdvancedOrdersLayout,
  EntropyAccountLayout,
  EntropyCache,
  QUOTE_INDEX,
  Cluster,
  Config,
  I80F48,
  IDS,
  ONE_I80F48,
  EntropyClient,
  sleep,
  ZERO_I80F48,
} from '.';
import { Account, Commitment, Connection, PublicKey } from '@solana/web3.js';
import { Market, OpenOrders } from '@project-serum/serum';
import BN from 'bn.js';
import { Orderbook } from '@project-serum/serum/lib/market';
import axios from 'axios';
//import * as Env from 'dotenv';
//import { expand } from 'dotenv-expand';

//expand(Env.config());

const interval = parseInt(process.env.INTERVAL || '3500');
const refreshAccountsInterval = parseInt(
  process.env.INTERVAL_ACCOUNTS || '600000',
);
const refreshWebsocketInterval = parseInt(
  process.env.INTERVAL_WEBSOCKET || '300000',
);
const rebalanceInterval = parseInt(process.env.INTERVAL_REBALANCE || '10000');
const checkTriggers = process.env.CHECK_TRIGGERS
  ? process.env.CHECK_TRIGGERS === 'true'
  : true;
const liabLimit = I80F48.fromNumber(
  Math.min(parseFloat(process.env.LIAB_LIMIT || '0.9'), 1),
);
let lastRebalance = Date.now();

const config = new Config(IDS);

const cluster = (process.env.CLUSTER || 'mainnet') as Cluster;
const groupName = process.env.GROUP || 'mainnet.2';
const groupIds = config.getGroup(cluster, groupName);
if (!groupIds) {
  throw new Error(`Group ${groupName} not found`);
}

// Target values to keep in spot, ordered the same as in entropy client's ids.json
// Example:
//
//         MNGO BTC ETH SOL USDT SRM RAY COPE FTT MSOL
// TARGETS=0    0   0   1   0    0   0   0    0   0
const TARGETS = process.env.TARGETS
  ? process.env.TARGETS.replace(/\s+/g,' ').trim().split(' ').map((s) => parseFloat(s))
  : [0, 0, 0, 0, 0, 0, 0, 0, 0];

const entropyProgramId = groupIds.entropyProgramId;
const entropyGroupKey = groupIds.publicKey;

const payer = new Account(
  JSON.parse(
    process.env.PRIVATE_KEY ||
      fs.readFileSync(
        process.env.KEYPAIR || os.homedir() + '/.config/solana/entropy-mainnet-authority.json',
        'utf-8',
      ),
  ),
);
console.log(`Payer: ${payer.publicKey.toBase58()}`);
const rpcEndpoint = process.env.RPC_ENDPOINT || config.cluster_urls[cluster];
const connection = new Connection(rpcEndpoint, 'confirmed' as Commitment);
const client = new EntropyClient(connection, entropyProgramId);

let entropySubscriptionId = -1;
let dexSubscriptionId = -1;

async function main() {
  if (!groupIds) {
    throw new Error(`Group ${groupName} not found`);
  }
  console.log(`Starting liquidator for ${groupName}...`);
  console.log(`RPC Endpoint: ${rpcEndpoint}`);

  const entropyGroup = await client.getEntropyGroup(entropyGroupKey);
  let cache = await entropyGroup.loadCache(connection);
  let liqorEntropyAccount: EntropyAccount;

  try {
    if (process.env.LIQOR_PK) {
      liqorEntropyAccount = await client.getEntropyAccount(
        new PublicKey(process.env.LIQOR_PK),
        entropyGroup.dexProgramId,
      );
      if (!liqorEntropyAccount.owner.equals(payer.publicKey)) {
        throw new Error('Account not owned by Keypair');
      }
    } else {
      const accounts = await client.getEntropyAccountsForOwner(
        entropyGroup,
        payer.publicKey,
        true,
      );
      if (accounts.length) {
        accounts.sort((a, b) =>
          b
            .computeValue(entropyGroup, cache)
            .sub(a.computeValue(entropyGroup, cache))
            .toNumber(),
        );
        liqorEntropyAccount = accounts[0];
      } else {
        throw new Error('No Entropy Account found for this Keypair');
      }
    }
  } catch (err: any) {
    console.error(`Error loading liqor Entropy Account: ${err}`);
    return;
  }

  console.log(`Liqor Public Key: ${liqorEntropyAccount.publicKey.toBase58()}`);

  const entropyAccounts: EntropyAccount[] = [];
  await refreshAccounts(entropyGroup, entropyAccounts);
  watchAccounts(groupIds.entropyProgramId, entropyGroup, entropyAccounts);

  const perpMarkets = await Promise.all(
    groupIds.perpMarkets.map((perpMarket) => {
      return entropyGroup.loadPerpMarket(
        connection,
        perpMarket.marketIndex,
        perpMarket.baseDecimals,
        perpMarket.quoteDecimals,
      );
    }),
  );
  const spotMarkets = await Promise.all(
    groupIds.spotMarkets.map((spotMarket) => {
      return Market.load(
        connection,
        spotMarket.publicKey,
        undefined,
        groupIds.serumProgramId,
      );
    }),
  );
  const rootBanks = await entropyGroup.loadRootBanks(connection);
  notify(`V3 Liquidator launched for group ${groupName}`);

  // eslint-disable-next-line
  while (true) {
    try {
      if (checkTriggers) {
        // load all the advancedOrders accounts
        const entropyAccountsWithAOs = entropyAccounts.filter(
          (ma) => ma.advancedOrdersKey && !ma.advancedOrdersKey.equals(zeroKey),
        );
        const allAOs = entropyAccountsWithAOs.map((ma) => ma.advancedOrdersKey);

        const advancedOrders = await getMultipleAccounts(connection, allAOs);
        [cache, liqorEntropyAccount] = await Promise.all([
          entropyGroup.loadCache(connection),
          liqorEntropyAccount.reload(connection, entropyGroup.dexProgramId),
        ]);

        entropyAccountsWithAOs.forEach((ma, i) => {
          const decoded = AdvancedOrdersLayout.decode(
            advancedOrders[i].accountInfo.data,
          );
          ma.advancedOrders = decoded.orders;
        });
      } else {
        [cache, liqorEntropyAccount] = await Promise.all([
          entropyGroup.loadCache(connection),
          liqorEntropyAccount.reload(connection, entropyGroup.dexProgramId),
        ]);
      }

      for (const entropyAccount of entropyAccounts) {
        const entropyAccountKeyString = entropyAccount.publicKey.toBase58();

        // Handle trigger orders for this entropy account
        if (checkTriggers && entropyAccount.advancedOrders) {
          try {
            await processTriggerOrders(
              entropyGroup,
              cache,
              perpMarkets,
              entropyAccount,
            );
          } catch (err: any) {
            if (err.message.includes('EntropyErrorCode::InvalidParam')) {
              console.error(
                'Failed to execute trigger order, order already executed',
              );
            } else if (
              err.message.includes('EntropyErrorCode::TriggerConditionFalse')
            ) {
              console.error(
                'Failed to execute trigger order, trigger condition was false',
              );
            } else {
              console.error(
                `Failed to execute trigger order for ${entropyAccountKeyString}: ${err}`,
              );
            }
          }
        }

        // If not liquidatable continue to next entropy account
        if (!entropyAccount.isLiquidatable(entropyGroup, cache)) {
          continue;
        }

        // Reload entropy account to make sure still liquidatable
        await entropyAccount.reload(connection, entropyGroup.dexProgramId);
        if (!entropyAccount.isLiquidatable(entropyGroup, cache)) {
          console.log(
            `Account ${entropyAccountKeyString} no longer liquidatable`,
          );
          continue;
        }

        const health = entropyAccount.getHealthRatio(entropyGroup, cache, 'Maint');
        const accountInfoString = entropyAccount.toPrettyString(
          groupIds,
          entropyGroup,
          cache,
        );
        console.log(
          `Sick account ${entropyAccountKeyString} health ratio: ${health.toString()}\n${accountInfoString}`,
        );
        notify(`Sick account\n${accountInfoString}`);
        try {
          await liquidateAccount(
            entropyGroup,
            cache,
            spotMarkets,
            rootBanks,
            perpMarkets,
            entropyAccount,
            liqorEntropyAccount,
          );

          console.log('Liquidated account', entropyAccountKeyString);
          notify(`Liquidated account ${entropyAccountKeyString}`);
        } catch (err: any) {
          console.error(
            `Failed to liquidate account ${entropyAccountKeyString}: ${err}`,
          );
          notify(
            `Failed to liquidate account ${entropyAccountKeyString}: ${err}`,
          );
        } finally {
          await balanceAccount(
            entropyGroup,
            liqorEntropyAccount,
            cache,
            spotMarkets,
            perpMarkets,
          );
        }
      }

      cache = await entropyGroup.loadCache(connection);
      await liqorEntropyAccount.reload(connection, entropyGroup.dexProgramId);

      // Check need to rebalance again after checking accounts
      await balanceAccount(
        entropyGroup,
        liqorEntropyAccount,
        cache,
        spotMarkets,
        perpMarkets,
      );
      await sleep(interval);
    } catch (err) {
      console.error('Error checking accounts:', err);
    }
  }
}

function watchAccounts(
  entropyProgramId: PublicKey,
  entropyGroup: EntropyGroup,
  entropyAccounts: EntropyAccount[],
) {
  try {
    console.log('Watching accounts...');
    const openOrdersAccountSpan = OpenOrders.getLayout(
      entropyGroup.dexProgramId,
    ).span;
    const openOrdersAccountOwnerOffset = OpenOrders.getLayout(
      entropyGroup.dexProgramId,
    ).offsetOf('owner');

    if (entropySubscriptionId != -1) {
      connection.removeProgramAccountChangeListener(entropySubscriptionId);
    }
    if (dexSubscriptionId != -1) {
      connection.removeProgramAccountChangeListener(dexSubscriptionId);
    }

    entropySubscriptionId = connection.onProgramAccountChange(
      entropyProgramId,
      async ({ accountId, accountInfo }) => {
        try {
          const index = entropyAccounts.findIndex((account) =>
            account.publicKey.equals(accountId),
          );

          const entropyAccount = new EntropyAccount(
            accountId,
            EntropyAccountLayout.decode(accountInfo.data),
          );
          if (index == -1) {
            entropyAccounts.push(entropyAccount);
          } else {
            const spotOpenOrdersAccounts =
              entropyAccounts[index].spotOpenOrdersAccounts;
            entropyAccount.spotOpenOrdersAccounts = spotOpenOrdersAccounts;
            entropyAccounts[index] = entropyAccount;
            await entropyAccount.loadOpenOrders(
              connection,
              entropyGroup.dexProgramId,
            );
          }
        } catch (err) {
          console.error(`could not update entropy account ${err}`);
        }
      },
      'processed',
      [
        { dataSize: EntropyAccountLayout.span },
        {
          memcmp: {
            offset: EntropyAccountLayout.offsetOf('entropyGroup'),
            bytes: entropyGroup.publicKey.toBase58(),
          },
        },
      ],
    );

    dexSubscriptionId = connection.onProgramAccountChange(
      entropyGroup.dexProgramId,
      ({ accountId, accountInfo }) => {
        const ownerIndex = entropyAccounts.findIndex((account) =>
          account.spotOpenOrders.some((key) => key.equals(accountId)),
        );

        if (ownerIndex > -1) {
          const openOrdersIndex = entropyAccounts[
            ownerIndex
          ].spotOpenOrders.findIndex((key) => key.equals(accountId));
          const openOrders = OpenOrders.fromAccountInfo(
            accountId,
            accountInfo,
            entropyGroup.dexProgramId,
          );
          entropyAccounts[ownerIndex].spotOpenOrdersAccounts[openOrdersIndex] =
            openOrders;
        } else {
          console.error('Could not match OpenOrdersAccount to EntropyAccount');
        }
      },
      'processed',
      [
        { dataSize: openOrdersAccountSpan },
        {
          memcmp: {
            offset: openOrdersAccountOwnerOffset,
            bytes: entropyGroup.signerKey.toBase58(),
          },
        },
      ],
    );
  } catch (err) {
    console.error('Error watching accounts', err);
  } finally {
    setTimeout(
      watchAccounts,
      refreshWebsocketInterval,
      entropyProgramId,
      entropyGroup,
      entropyAccounts,
    );
  }
}

async function refreshAccounts(
  entropyGroup: EntropyGroup,
  entropyAccounts: EntropyAccount[],
) {
  try {
    console.log('Refreshing accounts...');
    console.time('getAllEntropyAccounts');

    entropyAccounts.splice(
      0,
      entropyAccounts.length,
      ...(await client.getAllEntropyAccounts(entropyGroup, undefined, true)),
    );
    shuffleArray(entropyAccounts);

    console.timeEnd('getAllEntropyAccounts');
    console.log(`Fetched ${entropyAccounts.length} accounts`);
  } catch (err: any) {
    console.error(`Error reloading accounts: ${err}`);
  } finally {
    setTimeout(
      refreshAccounts,
      refreshAccountsInterval,
      entropyGroup,
      entropyAccounts,
    );
  }
}

/**
 * Process trigger orders for one entropy account
 */
async function processTriggerOrders(
  entropyGroup: EntropyGroup,
  cache: EntropyCache,
  perpMarkets: PerpMarket[],
  entropyAccount: EntropyAccount,
) {
  if (!groupIds) {
    throw new Error(`Group ${groupName} not found`);
  }

  for (let i = 0; i < entropyAccount.advancedOrders.length; i++) {
    const order = entropyAccount.advancedOrders[i];
    if (!(order.perpTrigger && order.perpTrigger.isActive)) {
      continue;
    }

    const trigger = order.perpTrigger;
    const currentPrice = cache.priceCache[trigger.marketIndex].price;
    const configMarketIndex = groupIds.perpMarkets.findIndex(
      (pm) => pm.marketIndex === trigger.marketIndex,
    );
    if (
      (trigger.triggerCondition == 'above' &&
        currentPrice.gt(trigger.triggerPrice)) ||
      (trigger.triggerCondition == 'below' &&
        currentPrice.lt(trigger.triggerPrice))
    ) {
      console.log(
        `Executing order for account ${entropyAccount.publicKey.toBase58()}`,
      );
      return client.executePerpTriggerOrder(
        entropyGroup,
        entropyAccount,
        cache,
        perpMarkets[configMarketIndex],
        payer,
        i,
      );
    }
  }
}

async function liquidateAccount(
  entropyGroup: EntropyGroup,
  cache: EntropyCache,
  spotMarkets: Market[],
  rootBanks: (RootBank | undefined)[],
  perpMarkets: PerpMarket[],
  liqee: EntropyAccount,
  liqor: EntropyAccount,
) {
  const hasPerpOpenOrders = liqee.perpAccounts.some(
    (pa) => pa.bidsQuantity.gt(ZERO_BN) || pa.asksQuantity.gt(ZERO_BN),
  );

  if (hasPerpOpenOrders) {
    console.log('forceCancelPerpOrders');
    await Promise.all(
      perpMarkets.map((perpMarket) => {
        return client.forceCancelAllPerpOrdersInMarket(
          entropyGroup,
          liqee,
          perpMarket,
          payer,
          10,
        );
      }),
    );
    await liqee.reload(connection, entropyGroup.dexProgramId);
    if (!liqee.isLiquidatable(entropyGroup, cache)) {
      throw new Error('Account no longer liquidatable');
    }
  }

  for (let r = 0; r < 5 && liqee.hasAnySpotOrders(); r++) {
    for (let i = 0; i < entropyGroup.spotMarkets.length; i++) {
      if (liqee.inMarginBasket[i]) {
        const spotMarket = spotMarkets[i];
        const baseRootBank = rootBanks[i];
        const quoteRootBank = rootBanks[QUOTE_INDEX];

        if (baseRootBank && quoteRootBank) {
          console.log('forceCancelOrders ', i);
          await client.forceCancelSpotOrders(
            entropyGroup,
            liqee,
            spotMarket,
            baseRootBank,
            quoteRootBank,
            payer,
            new BN(5),
          );
        }
      }
    }

    await liqee.reload(connection, entropyGroup.dexProgramId);
    if (!liqee.isLiquidatable(entropyGroup, cache)) {
      throw new Error('Account no longer liquidatable');
    }
  }

  const healthComponents = liqee.getHealthComponents(entropyGroup, cache);
  const maintHealths = liqee.getHealthsFromComponents(
    entropyGroup,
    cache,
    healthComponents.spot,
    healthComponents.perps,
    healthComponents.quote,
    'Maint',
  );

  let shouldLiquidateSpot = false;
  for (let i = 0; i < entropyGroup.tokens.length; i++) {
    if (liqee.getNet(cache.rootBankCache[i], i).isNeg()) {
      shouldLiquidateSpot = true;
      break;
    }
  }

  if (shouldLiquidateSpot) {
    await liquidateSpot(
      entropyGroup,
      cache,
      perpMarkets,
      rootBanks,
      liqee,
      liqor,
    );
    await liqee.reload(connection, entropyGroup.dexProgramId);
    if (!liqee.isLiquidatable(entropyGroup, cache)) {
      return;
    }
  }

  await liquidatePerps(entropyGroup, cache, perpMarkets, rootBanks, liqee, liqor);

  if (
    !shouldLiquidateSpot &&
    !maintHealths.perp.isNeg() &&
    liqee.beingLiquidated
  ) {
    // Send a ForceCancelPerp to reset the being_liquidated flag
    console.log('forceCancelAllPerpOrdersInMarket');
    await client.forceCancelAllPerpOrdersInMarket(
      entropyGroup,
      liqee,
      perpMarkets[0],
      payer,
      10,
    );
  }
}

async function liquidateSpot(
  entropyGroup: EntropyGroup,
  cache: EntropyCache,
  perpMarkets: PerpMarket[],
  rootBanks: (RootBank | undefined)[],
  liqee: EntropyAccount,
  liqor: EntropyAccount,
) {
  console.log('liquidateSpot');

  let minNet = ZERO_I80F48;
  let minNetIndex = -1;
  let maxNet = ZERO_I80F48;
  let maxNetIndex = -1;

  for (let i = 0; i < entropyGroup.tokens.length; i++) {
    const price = cache.priceCache[i] ? cache.priceCache[i].price : ONE_I80F48;
    const netDeposit = liqee
      .getNativeDeposit(cache.rootBankCache[i], i)
      .sub(liqee.getNativeBorrow(cache.rootBankCache[i], i))
      .mul(price);

    if (netDeposit.lt(minNet)) {
      minNet = netDeposit;
      minNetIndex = i;
    } else if (netDeposit.gt(maxNet)) {
      maxNet = netDeposit;
      maxNetIndex = i;
    }
  }
  if (minNetIndex == -1) {
    throw new Error('min net index neg 1');
  }

  if (minNetIndex == maxNetIndex) {
    maxNetIndex = QUOTE_INDEX;
  }

  const liabRootBank = rootBanks[minNetIndex];
  const assetRootBank = rootBanks[maxNetIndex];

  if (assetRootBank && liabRootBank) {
    const liqorInitHealth = liqor.getHealth(entropyGroup, cache, 'Init');
    const liabInitLiabWeight = entropyGroup.spotMarkets[minNetIndex]
      ? entropyGroup.spotMarkets[minNetIndex].initLiabWeight
      : ONE_I80F48;
    const assetInitAssetWeight = entropyGroup.spotMarkets[maxNetIndex]
      ? entropyGroup.spotMarkets[maxNetIndex].initAssetWeight
      : ONE_I80F48;

    const maxLiabTransfer = liqorInitHealth
      .div(
        entropyGroup
          .getPriceNative(minNetIndex, cache)
          .mul(liabInitLiabWeight.sub(assetInitAssetWeight).abs()),
      )
      .mul(liabLimit);

    if (liqee.isBankrupt) {
      console.log('Bankrupt account', liqee.publicKey.toBase58());
      const quoteRootBank = rootBanks[QUOTE_INDEX];
      if (quoteRootBank) {
        await client.resolveTokenBankruptcy(
          entropyGroup,
          liqee,
          liqor,
          quoteRootBank,
          liabRootBank,
          payer,
          maxLiabTransfer,
        );
        await liqee.reload(connection, entropyGroup.dexProgramId);
      }
    } else {
      if (maxNet.lt(ZERO_I80F48) || maxNetIndex == -1) {
        const highestHealthMarket = perpMarkets
          .map((perpMarket, i) => {
            const marketIndex = entropyGroup.getPerpMarketIndex(
              perpMarket.publicKey,
            );
            const perpMarketInfo = entropyGroup.perpMarkets[marketIndex];
            const perpAccount = liqee.perpAccounts[marketIndex];
            const perpMarketCache = cache.perpMarketCache[marketIndex];
            const price = entropyGroup.getPriceNative(marketIndex, cache);
            const perpHealth = perpAccount.getHealth(
              perpMarketInfo,
              price,
              perpMarketInfo.maintAssetWeight,
              perpMarketInfo.maintLiabWeight,
              perpMarketCache.longFunding,
              perpMarketCache.shortFunding,
            );
            return { perpHealth: perpHealth, marketIndex: marketIndex, i };
          })
          .sort((a, b) => {
            return b.perpHealth.sub(a.perpHealth).toNumber();
          })[0];

        let maxLiabTransfer = liqorInitHealth.mul(liabLimit);
        if (maxNetIndex !== QUOTE_INDEX) {
          maxLiabTransfer = liqorInitHealth
            .div(ONE_I80F48.sub(assetInitAssetWeight))
            .mul(liabLimit);
        }

        console.log('liquidateTokenAndPerp', highestHealthMarket.marketIndex);
        await client.liquidateTokenAndPerp(
          entropyGroup,
          liqee,
          liqor,
          liabRootBank,
          payer,
          AssetType.Perp,
          highestHealthMarket.marketIndex,
          AssetType.Token,
          minNetIndex,
          maxLiabTransfer,
        );
      } else {
        console.log('liquidateTokenAndToken', maxNetIndex, minNetIndex);
        await client.liquidateTokenAndToken(
          entropyGroup,
          liqee,
          liqor,
          assetRootBank,
          liabRootBank,
          payer,
          maxLiabTransfer,
        );
      }

      await liqee.reload(connection, entropyGroup.dexProgramId);
      if (liqee.isBankrupt) {
        console.log('Bankrupt account', liqee.publicKey.toBase58());
        const quoteRootBank = rootBanks[QUOTE_INDEX];
        if (quoteRootBank) {
          await client.resolveTokenBankruptcy(
            entropyGroup,
            liqee,
            liqor,
            quoteRootBank,
            liabRootBank,
            payer,
            maxLiabTransfer,
          );
          await liqee.reload(connection, entropyGroup.dexProgramId);
        }
      }
    }
  }
}

async function liquidatePerps(
  entropyGroup: EntropyGroup,
  cache: EntropyCache,
  perpMarkets: PerpMarket[],
  rootBanks: (RootBank | undefined)[],
  liqee: EntropyAccount,
  liqor: EntropyAccount,
) {
  console.log('liquidatePerps');
  const lowestHealthMarket = perpMarkets
    .map((perpMarket, i) => {
      const marketIndex = entropyGroup.getPerpMarketIndex(perpMarket.publicKey);
      const perpMarketInfo = entropyGroup.perpMarkets[marketIndex];
      const perpAccount = liqee.perpAccounts[marketIndex];
      const perpMarketCache = cache.perpMarketCache[marketIndex];
      const price = entropyGroup.getPriceNative(marketIndex, cache);
      const perpHealth = perpAccount.getHealth(
        perpMarketInfo,
        price,
        perpMarketInfo.maintAssetWeight,
        perpMarketInfo.maintLiabWeight,
        perpMarketCache.longFunding,
        perpMarketCache.shortFunding,
      );
      return { perpHealth: perpHealth, marketIndex: marketIndex, i };
    })
    .sort((a, b) => {
      return a.perpHealth.sub(b.perpHealth).toNumber();
    })[0];

  if (!lowestHealthMarket) {
    throw new Error('Couldnt find a perp market to liquidate');
  }

  const marketIndex = lowestHealthMarket.marketIndex;
  const perpAccount = liqee.perpAccounts[marketIndex];
  const perpMarket = perpMarkets[lowestHealthMarket.i];

  if (!perpMarket) {
    throw new Error(`Perp market not found for ${marketIndex}`);
  }

  const liqorInitHealth = liqor.getHealth(entropyGroup, cache, 'Init');
  let maxLiabTransfer = liqorInitHealth.mul(liabLimit);
  if (liqee.isBankrupt) {
    const quoteRootBank = rootBanks[QUOTE_INDEX];
    if (quoteRootBank) {
      // don't do anything it if quote position is zero
      console.log('resolvePerpBankruptcy', maxLiabTransfer.toString());
      await client.resolvePerpBankruptcy(
        entropyGroup,
        liqee,
        liqor,
        perpMarket,
        quoteRootBank,
        payer,
        marketIndex,
        maxLiabTransfer,
      );
      await liqee.reload(connection, entropyGroup.dexProgramId);
    }
  } else {
    let maxNet = ZERO_I80F48;
    let maxNetIndex = entropyGroup.tokens.length - 1;

    for (let i = 0; i < entropyGroup.tokens.length; i++) {
      const price = cache.priceCache[i]
        ? cache.priceCache[i].price
        : ONE_I80F48;

      const netDeposit = liqee.getNet(cache.rootBankCache[i], i).mul(price);
      if (netDeposit.gt(maxNet)) {
        maxNet = netDeposit;
        maxNetIndex = i;
      }
    }

    const assetRootBank = rootBanks[maxNetIndex];
    const liqorInitHealth = liqor.getHealth(entropyGroup, cache, 'Init');
    if (perpAccount.basePosition.isZero()) {
      if (assetRootBank) {
        // we know that since sum of perp healths is negative, lowest perp market must be negative
        console.log('liquidateTokenAndPerp', marketIndex);
        if (maxNetIndex !== QUOTE_INDEX) {
          maxLiabTransfer = liqorInitHealth
            .div(
              ONE_I80F48.sub(
                entropyGroup.spotMarkets[maxNetIndex].initAssetWeight,
              ),
            )
            .mul(liabLimit);
        }
        await client.liquidateTokenAndPerp(
          entropyGroup,
          liqee,
          liqor,
          assetRootBank,
          payer,
          AssetType.Token,
          maxNetIndex,
          AssetType.Perp,
          marketIndex,
          maxLiabTransfer,
        );
      }
    } else {
      console.log('liquidatePerpMarket', marketIndex);

      // technically can be higher because of liquidation fee, but
      // let's just give ourselves extra room
      const perpMarketInfo = entropyGroup.perpMarkets[marketIndex];
      const initAssetWeight = perpMarketInfo.initAssetWeight;
      const initLiabWeight = perpMarketInfo.initLiabWeight;
      let baseTransferRequest;
      if (perpAccount.basePosition.gte(ZERO_BN)) {
        // TODO adjust for existing base position on liqor
        baseTransferRequest = new BN(
          liqorInitHealth
            .div(ONE_I80F48.sub(initAssetWeight))
            .div(entropyGroup.getPriceNative(marketIndex, cache))
            .div(I80F48.fromI64(perpMarketInfo.baseLotSize))
            .floor()
            .mul(liabLimit)
            .toNumber(),
        );
      } else {
        baseTransferRequest = new BN(
          liqorInitHealth
            .div(initLiabWeight.sub(ONE_I80F48))
            .div(entropyGroup.getPriceNative(marketIndex, cache))
            .div(I80F48.fromI64(perpMarketInfo.baseLotSize))
            .floor()
            .mul(liabLimit)
            .toNumber(),
        ).neg();
      }

      await client.liquidatePerpMarket(
        entropyGroup,
        liqee,
        liqor,
        perpMarket,
        payer,
        baseTransferRequest,
      );
    }

    await liqee.reload(connection, entropyGroup.dexProgramId);
    if (liqee.isBankrupt) {
      const maxLiabTransfer = liqorInitHealth.mul(liabLimit);
      const quoteRootBank = rootBanks[QUOTE_INDEX];
      if (quoteRootBank) {
        console.log('resolvePerpBankruptcy', maxLiabTransfer.toString());
        await client.resolvePerpBankruptcy(
          entropyGroup,
          liqee,
          liqor,
          perpMarket,
          quoteRootBank,
          payer,
          marketIndex,
          maxLiabTransfer,
        );
      }
      await liqee.reload(connection, entropyGroup.dexProgramId);
    }
  }
}

function getDiffsAndNet(
  entropyGroup: EntropyGroup,
  entropyAccount: EntropyAccount,
  cache: EntropyCache,
) {
  const diffs: I80F48[] = [];
  const netValues: [number, I80F48, number][] = [];
  // Go to each base currency and see if it's above or below target

  for (let i = 0; i < groupIds!.spotMarkets.length; i++) {
    const target = TARGETS[i] !== undefined ? TARGETS[i] : 0;
    const marketIndex = groupIds!.spotMarkets[i].marketIndex;
    const diff = entropyAccount
      .getUiDeposit(cache.rootBankCache[marketIndex], entropyGroup, marketIndex)
      .sub(entropyAccount.getUiBorrow(cache.rootBankCache[marketIndex], entropyGroup, marketIndex))
      .sub(I80F48.fromNumber(target));
    diffs.push(diff);
    netValues.push([i, diff.mul(cache.priceCache[i].price), marketIndex]);
  }

  return { diffs, netValues };
}

async function balanceAccount(
  entropyGroup: EntropyGroup,
  entropyAccount: EntropyAccount,
  entropyCache: EntropyCache,
  spotMarkets: Market[],
  perpMarkets: PerpMarket[],
) {
  if (Date.now() < lastRebalance + rebalanceInterval) {
    return;
  }

  const { diffs, netValues } = getDiffsAndNet(
    entropyGroup,
    entropyAccount,
    entropyCache,
  );
  const tokensUnbalanced = netValues.some(
    (nv) => Math.abs(diffs[nv[0]].toNumber()) > spotMarkets[nv[0]].minOrderSize,
  );
  const positionsUnbalanced = perpMarkets.some((pm) => {
    const index = entropyGroup.getPerpMarketIndex(pm.publicKey);
    const perpAccount = entropyAccount.perpAccounts[index];
    const basePositionSize = Math.abs(
      pm.baseLotsToNumber(perpAccount.basePosition),
    );

    return basePositionSize != 0 || perpAccount.quotePosition.gt(ZERO_I80F48);
  });

  if (tokensUnbalanced) {
    await balanceTokens(entropyGroup, entropyAccount, spotMarkets);
  }

  if (positionsUnbalanced) {
    await closePositions(entropyGroup, entropyAccount, perpMarkets);
  }

  lastRebalance = Date.now();
}

async function balanceTokens(
  entropyGroup: EntropyGroup,
  entropyAccount: EntropyAccount,
  markets: Market[],
) {
  try {
    console.log('balanceTokens');
    await entropyAccount.reload(connection, entropyGroup.dexProgramId);
    const cache = await entropyGroup.loadCache(connection);
    const cancelOrdersPromises: Promise<string>[] = [];
    const bidsInfo = await getMultipleAccounts(
      connection,
      markets.map((m) => m.bidsAddress),
    );
    const bids = bidsInfo
      ? bidsInfo.map((o, i) => Orderbook.decode(markets[i], o.accountInfo.data))
      : [];
    const asksInfo = await getMultipleAccounts(
      connection,
      markets.map((m) => m.asksAddress),
    );
    const asks = asksInfo
      ? asksInfo.map((o, i) => Orderbook.decode(markets[i], o.accountInfo.data))
      : [];

    for (let i = 0; i < markets.length; i++) {
      const marketIndex = entropyGroup.getSpotMarketIndex(markets[i].publicKey);
      const orders = [...bids[i], ...asks[i]].filter((o) =>
        o.openOrdersAddress.equals(entropyAccount.spotOpenOrders[marketIndex]),
      );

      for (const order of orders) {
        cancelOrdersPromises.push(
          client.cancelSpotOrder(
            entropyGroup,
            entropyAccount,
            payer,
            markets[i],
            order,
          ),
        );
      }
    }
    console.log(`Cancelling ${cancelOrdersPromises.length} orders`);
    await Promise.all(cancelOrdersPromises);

    const openOrders = await entropyAccount.loadOpenOrders(
      connection,
      entropyGroup.dexProgramId,
    );
    const settlePromises: Promise<string>[] = [];
    for (let i = 0; i < markets.length; i++) {
      const marketIndex = entropyGroup.getSpotMarketIndex(markets[i].publicKey);
      const oo = openOrders[marketIndex];
      if (
        oo &&
        (oo.quoteTokenTotal.add(oo['referrerRebatesAccrued']).gt(new BN(0)) ||
          oo.baseTokenTotal.gt(new BN(0)))
      ) {
        settlePromises.push(
          client.settleFunds(entropyGroup, entropyAccount, payer, markets[i]),
        );
      }
    }
    console.log(`Settling on ${settlePromises.length} markets`);
    await Promise.all(settlePromises);

    const { diffs, netValues } = getDiffsAndNet(
      entropyGroup,
      entropyAccount,
      cache,
    );

    netValues.sort((a, b) => b[1].sub(a[1]).toNumber());
    for (let i = 0; i < groupIds!.spotMarkets.length; i++) {
      const marketIndex = netValues[i][2];
      const netIndex = netValues[i][0];
      const marketConfig = groupIds!.spotMarkets.find((m) => m.marketIndex == marketIndex)!
      const market = markets.find((m) => m.publicKey.equals(entropyGroup.spotMarkets[marketIndex].spotMarket))!;
      const liquidationFee = entropyGroup.spotMarkets[marketIndex].liquidationFee;
      if (Math.abs(diffs[netIndex].toNumber()) > market!.minOrderSize) {
        const side = netValues[i][1].gt(ZERO_I80F48) ? 'sell' : 'buy';
        const price = entropyGroup
          .getPrice(marketIndex, cache)
          .mul(
            side == 'buy'
              ? ONE_I80F48.add(liquidationFee)
              : ONE_I80F48.sub(liquidationFee),
          )
          .toNumber();
        const quantity = Math.abs(diffs[netIndex].toNumber());

        console.log(
          `${side}ing ${quantity} of ${marketConfig.baseSymbol} for $${price}`,
        );
        await client.placeSpotOrder(
          entropyGroup,
          entropyAccount,
          entropyGroup.entropyCache,
          market,
          payer,
          side,
          price,
          Math.abs(diffs[netIndex].toNumber()),
          'limit',
        );
        await client.settleFunds(
          entropyGroup,
          entropyAccount,
          payer,
          markets[marketIndex],
        );
      }
    }
  } catch (err) {
    console.error('Error rebalancing tokens', err);
  }
}

async function closePositions(
  entropyGroup: EntropyGroup,
  entropyAccount: EntropyAccount,
  perpMarkets: PerpMarket[],
) {
  try {
    console.log('closePositions');
    await entropyAccount.reload(connection, entropyGroup.dexProgramId);
    const cache = await entropyGroup.loadCache(connection);

    for (let i = 0; i < perpMarkets.length; i++) {
      const perpMarket = perpMarkets[i];
      const index = entropyGroup.getPerpMarketIndex(perpMarket.publicKey);
      const perpAccount = entropyAccount.perpAccounts[index];

      if (perpMarket && perpAccount) {
        const openOrders = await perpMarket.loadOrdersForAccount(
          connection,
          entropyAccount,
        );

        for (const oo of openOrders) {
          await client.cancelPerpOrder(
            entropyGroup,
            entropyAccount,
            payer,
            perpMarket,
            oo,
          );
        }

        const basePositionSize = Math.abs(
          perpMarket.baseLotsToNumber(perpAccount.basePosition),
        );
        const price = entropyGroup.getPrice(index, cache);

        if (basePositionSize != 0) {
          const side = perpAccount.basePosition.gt(ZERO_BN) ? 'sell' : 'buy';
          const liquidationFee = entropyGroup.perpMarkets[index].liquidationFee;
          const orderPrice =
            side == 'sell'
              ? price.mul(ONE_I80F48.sub(liquidationFee)).toNumber()
              : price.mul(ONE_I80F48.add(liquidationFee)).toNumber();
          const bookSideInfo =
            side == 'sell'
              ? await connection.getAccountInfo(perpMarket.bids)
              : await connection.getAccountInfo(perpMarket.asks);

          console.log(
            `${side}ing ${basePositionSize} of ${groupIds?.perpMarkets[i].baseSymbol}-PERP for $${orderPrice}`,
          );

          await client.placePerpOrder(
            entropyGroup,
            entropyAccount,
            cache.publicKey,
            perpMarket,
            payer,
            side,
            orderPrice,
            basePositionSize,
            'ioc',
            0,
            bookSideInfo ? bookSideInfo : undefined,
            true,
          );
        }

        await entropyAccount.reload(connection, entropyGroup.dexProgramId);

        if (perpAccount.quotePosition.gt(ZERO_I80F48)) {
          const quoteRootBank = entropyGroup.rootBankAccounts[QUOTE_INDEX];
          if (quoteRootBank) {
            console.log('settlePnl');
            await client.settlePnl(
              entropyGroup,
              cache,
              entropyAccount,
              perpMarket,
              quoteRootBank,
              cache.priceCache[index].price,
              payer,
            );
          }
        }
      }
    }
  } catch (err) {
    console.error('Error closing positions', err);
  }
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function notify(content: string) {
  if (content && process.env.WEBHOOK_URL) {
    try {
      axios.post(process.env.WEBHOOK_URL, { content });
    } catch (err) {
      console.error('Error posting to notify webhook:', err);
    }
  }
}

process.on('unhandledRejection', (err: any, p: any) => {
  console.error(`Unhandled rejection: ${err} promise: ${p})`);
});

main();