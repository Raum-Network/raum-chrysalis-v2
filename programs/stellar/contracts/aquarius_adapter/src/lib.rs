#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, IntoVal, String, Symbol, Val, Vec, token::Client as TokenClient,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Executor,
    Router,
    Pool,
    Permissionless,
    Paused,
    Receipt(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum AquariusAction {
    SwapChained,
    SwapChainedStrictReceive,
    Deposit,
    Withdraw,
    Swap,
}

#[contracttype]
#[derive(Clone)]
pub struct RelayParams {
    pub recipient: Address,
    pub token: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct AdapterReceipt {
    pub caller: Address,
    pub target: Address,
    pub action: AquariusAction,
    pub method: Symbol,
    pub amount_in: i128,
    pub min_amount_out: i128,
    pub memo: String,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct AquariusAdapterConfig {
    pub admin: Address,
    pub executor: Address,
    pub router: Address,
    pub pool: Option<Address>,
    pub permissionless: bool,
    pub paused: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AquariusAdapterError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    Paused = 4,
    WrongTarget = 5,
    WrongMethod = 6,
    WrongPool = 7,
}

#[contract]
pub struct AquariusAdapter;

#[contractimpl]
impl AquariusAdapter {
    pub fn initialize(
        env: Env,
        admin: Address,
        router: Address,
        executor: Address,
        permissionless: bool,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, AquariusAdapterError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Router, &router);
        env.storage().instance().set(&DataKey::Executor, &executor);
        env.storage().instance().set(&DataKey::Permissionless, &permissionless);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((symbol_short!("aquarius"), symbol_short!("init")), admin);
    }

    pub fn set_executor(env: Env, admin: Address, executor: Address) {
        require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Executor, &executor);
        env.events().publish((symbol_short!("aquarius"), symbol_short!("executor")), executor);
    }

    pub fn set_router(env: Env, admin: Address, router: Address) {
        require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Router, &router);
        env.events().publish((symbol_short!("aquarius"), symbol_short!("router")), router);
    }

    pub fn set_pool(env: Env, admin: Address, pool: Address) {
        require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Pool, &pool);
        env.events().publish((symbol_short!("aquarius"), symbol_short!("pool")), pool);
    }

    pub fn set_permissionless(env: Env, admin: Address, permissionless: bool) {
        require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Permissionless, &permissionless);
        env.events().publish((symbol_short!("aquarius"), symbol_short!("public")), permissionless);
    }

    pub fn set_paused(env: Env, admin: Address, paused: bool) {
        require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Paused, &paused);
        env.events().publish((symbol_short!("aquarius"), symbol_short!("paused")), paused);
    }

    /// Executes an Aquarius router call after validating the target contract and method.
    ///
    /// The Chrysalis V2 executor builds the Soroban argument vector from live Aquarius path-finding.
    /// This adapter only enforces policy and records the cross-chain intent receipt.
    pub fn execute(
        env: Env,
        caller: Address,
        intent_id: BytesN<32>,
        action: AquariusAction,
        target: Address,
        method: Symbol,
        args: Vec<Val>,
        amount_in: i128,
        min_amount_out: i128,
        memo: String,
        relay: Option<RelayParams>,
    ) -> Val {
        caller.require_auth();
        require_ready(&env);
        require_authorized(&env, &caller);
        validate_target(&env, &target);
        validate_method(&env, &action, &method);

        let mut balance_before: i128 = 0;
        if let Some(r) = &relay {
            let client = TokenClient::new(&env, &r.token);
            balance_before = client.balance(&caller);
        }

        let result: Val = env.invoke_contract(&target, &method, args);
        
        let receipt = AdapterReceipt {
            caller: caller.clone(),
            target: target.clone(),
            action,
            method: method.clone(),
            amount_in,
            min_amount_out,
            memo,
            timestamp: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&DataKey::Receipt(intent_id.clone()), &receipt);
        env.events().publish(
            (symbol_short!("aquarius"), symbol_short!("exec")),
            (intent_id, caller.clone(), target, method, amount_in, min_amount_out),
        );

        if let Some(r) = relay {
            if r.recipient != caller {
                let client = TokenClient::new(&env, &r.token);
                let balance_after = client.balance(&caller);
                let diff = balance_after - balance_before;
                if diff > 0 {
                    client.transfer(&caller, &r.recipient, &diff);
                }
            }
        }

        result
    }

    /// Executes a direct Aquarius pool swap without using the router.
    ///
    /// This is intended for single-pool routes such as testnet USDC -> XLM when router-level
    /// emergency mode blocks `swap_chained`. The pool target is still pinned by admin config.
    pub fn swap_direct(
        env: Env,
        caller: Address,
        intent_id: BytesN<32>,
        pool: Address,
        in_idx: u32,
        out_idx: u32,
        amount_in: u128,
        min_amount_out: u128,
        memo: String,
        relay: Option<RelayParams>,
    ) -> u128 {
        caller.require_auth();
        require_ready(&env);
        require_authorized(&env, &caller);
        validate_pool(&env, &pool);

        let mut balance_before: i128 = 0;
        if let Some(r) = &relay {
            let client = TokenClient::new(&env, &r.token);
            balance_before = client.balance(&caller);
        }

        let mut args = Vec::new(&env);
        args.push_back(caller.clone().into_val(&env));
        args.push_back(in_idx.into_val(&env));
        args.push_back(out_idx.into_val(&env));
        args.push_back(amount_in.into_val(&env));
        args.push_back(min_amount_out.into_val(&env));

        let method = Symbol::new(&env, "swap");
        let result: u128 = env.invoke_contract(&pool, &method, args);

        let receipt = AdapterReceipt {
            caller: caller.clone(),
            target: pool.clone(),
            action: AquariusAction::Swap,
            method: method.clone(),
            amount_in: amount_in as i128,
            min_amount_out: min_amount_out as i128,
            memo,
            timestamp: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&DataKey::Receipt(intent_id.clone()), &receipt);
        env.events().publish(
            (symbol_short!("aquarius"), symbol_short!("direct")),
            (intent_id, caller.clone(), pool, in_idx, out_idx, amount_in, min_amount_out, result),
        );

        if let Some(r) = relay {
            if r.recipient != caller {
                let client = TokenClient::new(&env, &r.token);
                let balance_after = client.balance(&caller);
                let diff = balance_after - balance_before;
                if diff > 0 {
                    client.transfer(&caller, &r.recipient, &diff);
                }
            }
        }

        result
    }

    pub fn get_receipt(env: Env, intent_id: BytesN<32>) -> Option<AdapterReceipt> {
        env.storage().persistent().get(&DataKey::Receipt(intent_id))
    }

    pub fn get_config(env: Env) -> AquariusAdapterConfig {
        AquariusAdapterConfig {
            admin: get_address(&env, DataKey::Admin),
            executor: get_address(&env, DataKey::Executor),
            router: get_address(&env, DataKey::Router),
            pool: env.storage().instance().get(&DataKey::Pool),
            permissionless: get_bool(&env, DataKey::Permissionless),
            paused: get_bool(&env, DataKey::Paused),
        }
    }
}

fn require_ready(env: &Env) {
    if !env.storage().instance().has(&DataKey::Admin) {
        panic_with_error!(env, AquariusAdapterError::NotInitialized);
    }
    if get_bool(env, DataKey::Paused) {
        panic_with_error!(env, AquariusAdapterError::Paused);
    }
}

fn require_admin(env: &Env, admin: &Address) {
    require_ready(env);
    admin.require_auth();
    let stored_admin = get_address(env, DataKey::Admin);
    if &stored_admin != admin {
        panic_with_error!(env, AquariusAdapterError::Unauthorized);
    }
}

fn require_authorized(env: &Env, caller: &Address) {
    if get_bool(env, DataKey::Permissionless) {
        return;
    }
    let admin = get_address(env, DataKey::Admin);
    let executor = get_address(env, DataKey::Executor);
    if caller != &admin && caller != &executor {
        panic_with_error!(env, AquariusAdapterError::Unauthorized);
    }
}

fn validate_target(env: &Env, target: &Address) {
    let expected = get_address(env, DataKey::Router);
    if &expected != target {
        panic_with_error!(env, AquariusAdapterError::WrongTarget);
    }
}

fn validate_pool(env: &Env, pool: &Address) {
    let expected = get_address(env, DataKey::Pool);
    if &expected != pool {
        panic_with_error!(env, AquariusAdapterError::WrongPool);
    }
}

fn validate_method(env: &Env, action: &AquariusAction, method: &Symbol) {
    let ok = match action {
        AquariusAction::SwapChained => {
            method == &Symbol::new(env, "swap_chained")
        }
        AquariusAction::SwapChainedStrictReceive => {
            method == &Symbol::new(env, "swap_chained_strict_receive")
        }
        AquariusAction::Deposit => method == &Symbol::new(env, "deposit"),
        AquariusAction::Withdraw => method == &Symbol::new(env, "withdraw"),
        AquariusAction::Swap => method == &Symbol::new(env, "swap"),
    };
    if !ok {
        panic_with_error!(env, AquariusAdapterError::WrongMethod);
    }
}

fn get_address(env: &Env, key: DataKey) -> Address {
    env.storage()
        .instance()
        .get(&key)
        .unwrap_or_else(|| panic_with_error!(env, AquariusAdapterError::NotInitialized))
}

fn get_bool(env: &Env, key: DataKey) -> bool {
    env.storage().instance().get(&key).unwrap_or(false)
}
