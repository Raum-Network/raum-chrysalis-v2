#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env, String};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Receipt(BytesN<32>),
}

#[contracttype]
#[derive(Clone)]
pub struct Receipt {
    pub recorder: Address,
    pub source_chain: String,
    pub protocol: String,
    pub tx_hash: String,
    pub timestamp: u64,
}

#[contract]
pub struct ArcStellarReceipts;

#[contractimpl]
impl ArcStellarReceipts {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn record(env: Env, recorder: Address, intent_id: BytesN<32>, source_chain: String, protocol: String, tx_hash: String) {
        recorder.require_auth();
        let receipt = Receipt { recorder, source_chain, protocol, tx_hash, timestamp: env.ledger().timestamp() };
        env.storage().persistent().set(&DataKey::Receipt(intent_id), &receipt);
    }

    pub fn get(env: Env, intent_id: BytesN<32>) -> Option<Receipt> {
        env.storage().persistent().get(&DataKey::Receipt(intent_id))
    }
}
