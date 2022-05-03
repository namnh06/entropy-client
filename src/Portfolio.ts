import fetch from 'node-fetch'


export type DataPoint = {
    UnixTime: number,
    Value: number,
};

export type UserActionDataPoint = {
    Amount: number,
    Decimal: number,
    GlobalID: string,
    Hash: string,
    UnixTime: number,
    UserAction: string,
  };

export type PortfolioDataPoint = {
    UnixTime: number,
    GlobalID: string,
    Value: number,
};

async function getSharePrice(globalId: string) {
    const query = await fetch(
        `https://friktion-labs.github.io/mainnet-tvl-snapshots/derived_timeseries/${globalId}_sharePricesByGlobalId.json`
        ).then((res) => res.json());
    return query;
}

async function getUnderlyingPrice(globalId: string) {
    const query = await fetch(
            `https://friktion-labs.github.io/mainnet-tvl-snapshots/derived_timeseries/${globalId}_pricesByCoingeckoId.json`
        ).then((res) => res.json());

    return query;
}

async function getUserActions(userAddress: string) {
    const query = await fetch(
            `https://solana-stream-dev-ztbl.ue1-eks-0.prod-czff.zettablock.dev/graphql?query={userTransactions(userAddress:
            "${userAddress}"){UnixTime,GlobalID,UserAction,Amount,Decimal,Hash}}`
        ).then((res) => res.json());
    return query;
}

function processUserActions(userActions: UserActionDataPoint[]) {
    for (let i = 0; i < userActions.length; i++) {
        userActions[i].UnixTime *= 1000;
        // If ETH/FTT, deposits/withdrawals use decimals of 6 instead of 8 after Sollet -> Wormhole Migration.
        if (["mainnet_income_call_eth", "mainnet_income_call_ftt"].includes(userActions[i].GlobalID) && userActions[i].UnixTime >= 1650592799000) {
            userActions[i].Decimal = 8;
        }
        userActions[i].Amount /= 10**userActions[i].Decimal;
    }
    return userActions
}

async function calculatePortfolioValue(globalId: string, userAddress: string) {
    let s = await getSharePrice(globalId);
    let p = await getUnderlyingPrice(globalId);
    let a = await getUserActions(userAddress);

    let sharePrices = s.map((element)=>({UnixTime: element[0], Value: element[1]} as DataPoint));
    let underlyingPrices = p.map((element)=>({UnixTime: element[0], Value: element[1]} as DataPoint));
    let userActions = processUserActions(a.userTransactions.map((element)=>(element as UserActionDataPoint)));

    let userActionsSpec = userActions.filter(element => element.GlobalID == globalId);

    let tokenPortfolio: PortfolioDataPoint[] = [];
    let USDCPortfolio: PortfolioDataPoint[] = [];

    let shareIndex = 0;
    let underlyingIndex = 0;
    let actionIndex = 0;

    let activeVaultTokenPosition = 0;
    let pendingWithdraws = 0;
    let pendingDeposits = 0;
    let pendingClaims = 0;
    // start this at 1.00 always
    let lastSharePriceValue = 1;
    let lastUnderlyingPriceValue = 0;

    // O(x+y+z) traverse Friktion History
    while (shareIndex < sharePrices.length || underlyingIndex < underlyingPrices.length || actionIndex < userActions.length) {
        const userAction: UserActionDataPoint = userActionsSpec[actionIndex];
        const sharePrice: DataPoint = sharePrices[shareIndex];
        const underlyingPrice: DataPoint = underlyingPrices[underlyingIndex];

        // Process the oldest event
        const oldestTime = Math.min(
            userAction ? userAction.UnixTime : Number.MAX_SAFE_INTEGER,
            sharePrice ? sharePrice.UnixTime : Number.MAX_SAFE_INTEGER,
            underlyingPrice ? underlyingPrice.UnixTime: Number.MAX_SAFE_INTEGER
        );
        // console.log("User Action: ", userAction, "Share Price: ", sharePrice, "Underlying Price: ", underlyingPrice, "Oldest Time: ", oldestTime);

        // Process Auctions
        if (sharePrice && sharePrice.UnixTime == oldestTime) {
            // Apply Withdraws
            activeVaultTokenPosition -= pendingWithdraws;
            pendingClaims += pendingWithdraws*sharePrice.Value;
            pendingWithdraws = 0;
            // Apply Deposits
            if (shareIndex < sharePrices.length) {
                activeVaultTokenPosition += pendingDeposits/sharePrices[shareIndex].Value;
                pendingDeposits = 0;
            }
            let tokenValue = activeVaultTokenPosition*sharePrice.Value+pendingDeposits+pendingClaims;
            tokenPortfolio.push({Value: tokenValue, GlobalID: globalId, UnixTime: sharePrice.UnixTime});
            lastSharePriceValue = sharePrice.Value;
            shareIndex += 1;

        }
        // Process Underlying Price Change
        else if (underlyingPrice && underlyingPrice.UnixTime == oldestTime) {
            const underlyingTokenHoldings = activeVaultTokenPosition*lastSharePriceValue+pendingDeposits+pendingClaims;
            if (underlyingTokenHoldings > 0) {
                let usdcValue = (underlyingTokenHoldings) * underlyingPrice.Value;
                USDCPortfolio.push({Value: usdcValue, GlobalID: globalId, UnixTime: underlyingPrice.UnixTime});
            }
            let lastUnderlyingPriceValue = underlyingPrice.Value;
            underlyingIndex += 1;
        }
        // Process User Action
        else if (userAction && userAction.UnixTime == oldestTime) {
            if (userActionsSpec[actionIndex].UserAction == "Deposit") {
                pendingDeposits += userAction.Amount;
            }
            else if (userActionsSpec[actionIndex].UserAction == "CancelPendingDeposit") {
                pendingDeposits -= userAction.Amount;
            }
            else if (userActionsSpec[actionIndex].UserAction == "Withdraw") {
                pendingWithdraws += userAction.Amount;
            }
            else if (userActionsSpec[actionIndex].UserAction == "CancelPendingWithdrawal") {
                pendingWithdraws -= userAction.Amount;
            }
            else if (userActionsSpec[actionIndex].UserAction == "ClaimPendingWithdrawal") {
                pendingClaims -= userAction.Amount;
                let tokenValue = activeVaultTokenPosition*lastSharePriceValue+pendingDeposits+pendingClaims;
                let usdcValue = tokenValue * lastUnderlyingPriceValue;;

                tokenPortfolio.push({Value: tokenValue, GlobalID: globalId, UnixTime: userAction.UnixTime});
                USDCPortfolio.push({Value: usdcValue, GlobalID: globalId, UnixTime: userAction.UnixTime});

            }
            actionIndex += 1;
        }
        else {
            break;
        }
    }
    var json = JSON.stringify(tokenPortfolio);
    var fs = require('fs');
    fs.writeFile('tokenPortfolioTest.json', json, 'utf8', function(err) {
        if (err) {
            console.log(err);
        }
    });

    var json = JSON.stringify(USDCPortfolio);
    var fs = require('fs');
    fs.writeFile('usdcPortfolioTest.json', json, 'utf8', function(err) {
        if (err) {
            console.log(err);
        }
    });
    return [tokenPortfolio, USDCPortfolio];
}

calculatePortfolioValue("mainnet_income_call_ftt", "DcRQUi3X9Krtqn3b5muCBt8VfUsGyj8jjr6ajbseZ2f9");

