#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, String, Symbol, Val, Vec, token::Client as TokenClient,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Executor,
    Pool,
    PoolFactory,
    Backstop,
    Permissionless,
    Paused,
    Receipt(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum BlendAction {
    Supply,
    Withdraw,
    Borrow,
    Repay,
    Claim,
    BackstopDeposit,
    BackstopQueueWithdrawal,
    BackstopWithdraw,
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
    pub action: BlendAction,
    pub method: Symbol,
    pub amount: i128,
    pub memo: String,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct BlendAdapterConfig {
    pub admin: Address,
    pub executor: Address,
    pub pool: Address,
    pub pool_factory: Address,
    pub backstop: Address,
    pub permissionless: bool,
    pub paused: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum BlendAdapterError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    Paused = 4,
    WrongTarget = 5,
    WrongMethod = 6,
}

#[contract]
pub struct BlendAdapter;

#[contractimpl]
impl BlendAdapter {
    pub fn initialize(
        env: Env,
        admin: Address,
        pool: Address,
        pool_factory: Address,
        backstop: Address,
        executor: Address,
        permissionless: bool,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, BlendAdapterError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Pool, &pool);
        env.storage().instance().set(&DataKey::PoolFactory, &pool_factory);
        env.storage().instance().set(&DataKey::Backstop, &backstop);
        env.storage().instance().set(&DataKey::Executor, &executor);
        env.storage().instance().set(&DataKey::Permissionless, &permissionless);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((symbol_short!("blend"), symbol_short!("init")), admin);
    }

    pub fn set_executor(env: Env, admin: Address, executor: Address) {
        require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Executor, &executor);
        env.events().publish((symbol_short!("blend"), symbol_short!("executor")), executor);
    }

    pub fn set_targets(env: Env, admin: Address, pool: Address, pool_factory: Address, backstop: Address) {
        require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Pool, &pool);
        env.storage().instance().set(&DataKey::PoolFactory, &pool_factory);
        env.storage().instance().set(&DataKey::Backstop, &backstop);
        env.events().publish((symbol_short!("blend"), symbol_short!("targets")), (pool, pool_factory, backstop));
    }

    pub fn set_permissionless(env: Env, admin: Address, permissionless: bool) {
        require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Permissionless, &permissionless);
        env.events().publish((symbol_short!("blend"), symbol_short!("public")), permissionless);
    }

    pub fn set_paused(env: Env, admin: Address, paused: bool) {
        require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Paused, &paused);
        env.events().publish((symbol_short!("blend"), symbol_short!("paused")), paused);
    }

    /// Executes a Blend pool/backstop call after validating target and method.
    ///
    /// Blend v2 user actions generally flow through a pool submit-style call with a vector
    /// of requests. The API/agent builds that typed request vector and passes it in `args`.
    /// The adapter is intentionally thin: it gates allowed Blend entrypoints, invokes the
    /// configured pool/backstop contract, and records a Chrysalis V2 receipt.
    pub fn execute(
        env: Env,
        caller: Address,
        intent_id: BytesN<32>,
        action: BlendAction,
        target: Address,
        method: Symbol,
        args: Vec<Val>,
        amount: i128,
        memo: String,
        relay: Option<RelayParams>,
    ) -> Val {
        caller.require_auth();
        require_ready(&env);
        require_authorized(&env, &caller);
        validate_target(&env, &action, &target);
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
            amount,
            memo,
            timestamp: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&DataKey::Receipt(intent_id.clone()), &receipt);
        env.events().publish(
            (symbol_short!("blend"), symbol_short!("exec")),
            (intent_id, caller.clone(), target, method, amount),
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

    pub fn get_config(env: Env) -> BlendAdapterConfig {
        BlendAdapterConfig {
            admin: get_address(&env, DataKey::Admin),
            executor: get_address(&env, DataKey::Executor),
            pool: get_address(&env, DataKey::Pool),
            pool_factory: get_address(&env, DataKey::PoolFactory),
            backstop: get_address(&env, DataKey::Backstop),
            permissionless: get_bool(&env, DataKey::Permissionless),
            paused: get_bool(&env, DataKey::Paused),
        }
    }
}

fn require_ready(env: &Env) {
    if !env.storage().instance().has(&DataKey::Admin) {
        panic_with_error!(env, BlendAdapterError::NotInitialized);
    }
    if get_bool(env, DataKey::Paused) {
        panic_with_error!(env, BlendAdapterError::Paused);
    }
}

fn require_admin(env: &Env, admin: &Address) {
    require_ready(env);
    admin.require_auth();
    let stored_admin = get_address(env, DataKey::Admin);
    if &stored_admin != admin {
        panic_with_error!(env, BlendAdapterError::Unauthorized);
    }
}

fn require_authorized(env: &Env, caller: &Address) {
    if get_bool(env, DataKey::Permissionless) {
        return;
    }
    let admin = get_address(env, DataKey::Admin);
    let executor = get_address(env, DataKey::Executor);
    if caller != &admin && caller != &executor {
        panic_with_error!(env, BlendAdapterError::Unauthorized);
    }
}

fn validate_target(env: &Env, action: &BlendAction, target: &Address) {
    let expected = match action {
        BlendAction::BackstopDeposit
        | BlendAction::BackstopQueueWithdrawal
        | BlendAction::BackstopWithdraw => get_address(env, DataKey::Backstop),
        _ => get_address(env, DataKey::Pool),
    };
    if &expected != target {
        panic_with_error!(env, BlendAdapterError::WrongTarget);
    }
}

fn validate_method(env: &Env, action: &BlendAction, method: &Symbol) {
    let ok = match action {
        BlendAction::Supply | BlendAction::Withdraw | BlendAction::Borrow | BlendAction::Repay => {
            method == &Symbol::new(env, "submit")
        }
        BlendAction::Claim => method == &Symbol::new(env, "claim"),
        BlendAction::BackstopDeposit => method == &Symbol::new(env, "deposit"),
        BlendAction::BackstopQueueWithdrawal => method == &Symbol::new(env, "queue_withdrawal"),
        BlendAction::BackstopWithdraw => method == &Symbol::new(env, "withdraw"),
    };
    if !ok {
        panic_with_error!(env, BlendAdapterError::WrongMethod);
    }
}

fn get_address(env: &Env, key: DataKey) -> Address {
    env.storage()
        .instance()
        .get(&key)
        .unwrap_or_else(|| panic_with_error!(env, BlendAdapterError::NotInitialized))
}

fn get_bool(env: &Env, key: DataKey) -> bool {
    env.storage().instance().get(&key).unwrap_or(false)
}
