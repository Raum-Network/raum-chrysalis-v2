use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash::hashv,
    instruction::{AccountMeta, Instruction},
    program::invoke,
};

declare_id!("24AymQN6bHur3txgqj9jgAy6cpSqQHhXrirgYJByvsaJ");

const MAX_MEMO_LEN: usize = 160;

// Allowlisted Kamino Lend (klend) Anchor instruction discriminators per action. The backend
// resolves the concrete reserve/obligation/vault/oracle accounts with the Kamino klend SDK and
// passes the serialized Anchor instruction data through `cpi_data`; this adapter only forwards a
// CPI whose discriminator matches one of these vetted tags.
const KAMINO_DEPOSIT_TAGS: [&[u8]; 2] = [
    b"global:deposit_reserve_liquidity",
    b"global:deposit_reserve_liquidity_and_obligation_collateral",
];
const KAMINO_WITHDRAW_TAGS: [&[u8]; 2] = [
    b"global:withdraw_obligation_collateral_and_redeem_reserve_collateral",
    b"global:redeem_reserve_collateral",
];
const KAMINO_BORROW_TAGS: [&[u8]; 1] = [b"global:borrow_obligation_liquidity"];
const KAMINO_REPAY_TAGS: [&[u8]; 1] = [b"global:repay_obligation_liquidity"];
const KAMINO_REFRESH_RESERVE_TAGS: [&[u8]; 1] = [b"global:refresh_reserve"];
const KAMINO_REFRESH_OBLIGATION_TAGS: [&[u8]; 1] = [b"global:refresh_obligation"];

#[program]
pub mod kamino_adapter {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        kamino_program: Pubkey,
        executor: Pubkey,
        permissionless: bool,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.executor = executor;
        config.kamino_program = kamino_program;
        config.permissionless = permissionless;
        config.paused = false;
        config.bump = ctx.bumps.config;
        emit!(KaminoAdapterConfigured {
            admin: config.admin,
            executor,
            kamino_program,
            permissionless,
        });
        Ok(())
    }

    pub fn set_executor(ctx: Context<AdminOnly>, executor: Pubkey) -> Result<()> {
        ctx.accounts.config.executor = executor;
        emit!(KaminoExecutorUpdated { executor });
        Ok(())
    }

    pub fn set_kamino_program(ctx: Context<AdminOnly>, kamino_program: Pubkey) -> Result<()> {
        ctx.accounts.config.kamino_program = kamino_program;
        emit!(KaminoProgramUpdated { kamino_program });
        Ok(())
    }

    pub fn set_permissionless(ctx: Context<AdminOnly>, permissionless: bool) -> Result<()> {
        ctx.accounts.config.permissionless = permissionless;
        emit!(KaminoPermissionlessUpdated { permissionless });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(KaminoPausedUpdated { paused });
        Ok(())
    }

    /// Executes a vetted Kamino Lend instruction via CPI.
    ///
    /// The backend/agent resolves the exact lending market, reserve, obligation, collateral and
    /// liquidity vaults, and oracle (Scope/Pyth) accounts using the Kamino klend SDK. This adapter
    /// enforces:
    /// - the destination program equals the configured Kamino Lend program,
    /// - the Anchor instruction discriminator is one of the allowed Kamino lending actions,
    /// - the caller is the admin/executor unless permissionless mode is enabled,
    /// - a per-intent receipt PDA is written after a successful CPI.
    pub fn execute<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteKamino<'info>>,
        intent_id: [u8; 32],
        action: KaminoAction,
        amount: u64,
        cpi_data: Vec<u8>,
        memo: String,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, KaminoAdapterError::Paused);
        require!(memo.as_bytes().len() <= MAX_MEMO_LEN, KaminoAdapterError::MemoTooLong);
        require_authorized(config, ctx.accounts.authority.key())?;
        require_keys_eq!(
            ctx.accounts.kamino_program.key(),
            config.kamino_program,
            KaminoAdapterError::WrongProgram
        );
        validate_kamino_discriminator(action, &cpi_data)?;

        forward_to_program(
            ctx.accounts.kamino_program.to_account_info(),
            ctx.remaining_accounts,
            cpi_data,
        )?;

        let receipt = &mut ctx.accounts.receipt;
        receipt.intent_id = intent_id;
        receipt.executor = ctx.accounts.authority.key();
        receipt.action = action.code();
        receipt.amount = amount;
        receipt.protocol_program = ctx.accounts.kamino_program.key();
        receipt.created_at = Clock::get()?.unix_timestamp;
        receipt.memo = memo;

        emit!(KaminoIntentExecuted {
            intent_id,
            executor: receipt.executor,
            action: receipt.action,
            amount,
            protocol_program: receipt.protocol_program,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = AdapterConfig::SPACE, seeds = [b"kamino-config"], bump)]
    pub config: Account<'info, AdapterConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"kamino-config"], bump = config.bump, has_one = admin @ KaminoAdapterError::Unauthorized)]
    pub config: Account<'info, AdapterConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(intent_id: [u8; 32])]
pub struct ExecuteKamino<'info> {
    #[account(mut, seeds = [b"kamino-config"], bump = config.bump)]
    pub config: Account<'info, AdapterConfig>,
    #[account(
        init,
        payer = authority,
        space = AdapterReceipt::SPACE,
        seeds = [b"kamino-receipt", intent_id.as_ref()],
        bump
    )]
    pub receipt: Account<'info, AdapterReceipt>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: address is checked against config.kamino_program before CPI.
    pub kamino_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct AdapterConfig {
    pub admin: Pubkey,
    pub executor: Pubkey,
    pub kamino_program: Pubkey,
    pub permissionless: bool,
    pub paused: bool,
    pub bump: u8,
}

impl AdapterConfig {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 1 + 1 + 1;
}

#[account]
pub struct AdapterReceipt {
    pub intent_id: [u8; 32],
    pub executor: Pubkey,
    /// Encoded KaminoAction code for cheap indexing in explorers/indexers.
    pub action: u8,
    pub amount: u64,
    pub protocol_program: Pubkey,
    pub created_at: i64,
    pub memo: String,
}

impl AdapterReceipt {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 8 + 32 + 8 + 4 + MAX_MEMO_LEN;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum KaminoAction {
    DepositReserveLiquidity,
    WithdrawReserveLiquidity,
    BorrowObligationLiquidity,
    RepayObligationLiquidity,
    RefreshReserve,
    RefreshObligation,
}

impl KaminoAction {
    pub fn code(self) -> u8 {
        match self {
            Self::DepositReserveLiquidity => 1,
            Self::WithdrawReserveLiquidity => 2,
            Self::BorrowObligationLiquidity => 3,
            Self::RepayObligationLiquidity => 4,
            Self::RefreshReserve => 5,
            Self::RefreshObligation => 6,
        }
    }
}

#[event]
pub struct KaminoAdapterConfigured {
    pub admin: Pubkey,
    pub executor: Pubkey,
    pub kamino_program: Pubkey,
    pub permissionless: bool,
}

#[event]
pub struct KaminoExecutorUpdated {
    pub executor: Pubkey,
}

#[event]
pub struct KaminoProgramUpdated {
    pub kamino_program: Pubkey,
}

#[event]
pub struct KaminoPermissionlessUpdated {
    pub permissionless: bool,
}

#[event]
pub struct KaminoPausedUpdated {
    pub paused: bool,
}

#[event]
pub struct KaminoIntentExecuted {
    pub intent_id: [u8; 32],
    pub executor: Pubkey,
    pub action: u8,
    pub amount: u64,
    pub protocol_program: Pubkey,
}

#[error_code]
pub enum KaminoAdapterError {
    #[msg("adapter is paused")]
    Paused,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("target program is not the configured Kamino Lend program")]
    WrongProgram,
    #[msg("CPI data is shorter than an Anchor discriminator")]
    CpiDataTooShort,
    #[msg("CPI instruction discriminator is not allowed for this Kamino action")]
    DiscriminatorNotAllowed,
    #[msg("memo exceeds adapter maximum length")]
    MemoTooLong,
}

fn require_authorized(config: &AdapterConfig, caller: Pubkey) -> Result<()> {
    if config.permissionless || caller == config.admin || caller == config.executor {
        Ok(())
    } else {
        err!(KaminoAdapterError::Unauthorized)
    }
}

fn validate_kamino_discriminator(action: KaminoAction, cpi_data: &[u8]) -> Result<()> {
    require!(cpi_data.len() >= 8, KaminoAdapterError::CpiDataTooShort);
    let tags = match action {
        KaminoAction::DepositReserveLiquidity => &KAMINO_DEPOSIT_TAGS[..],
        KaminoAction::WithdrawReserveLiquidity => &KAMINO_WITHDRAW_TAGS[..],
        KaminoAction::BorrowObligationLiquidity => &KAMINO_BORROW_TAGS[..],
        KaminoAction::RepayObligationLiquidity => &KAMINO_REPAY_TAGS[..],
        KaminoAction::RefreshReserve => &KAMINO_REFRESH_RESERVE_TAGS[..],
        KaminoAction::RefreshObligation => &KAMINO_REFRESH_OBLIGATION_TAGS[..],
    };

    for tag in tags {
        let hash = hashv(&[*tag]).to_bytes();
        if cpi_data[..8] == hash[..8] {
            return Ok(());
        }
    }
    err!(KaminoAdapterError::DiscriminatorNotAllowed)
}

fn forward_to_program<'info>(
    program: AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    cpi_data: Vec<u8>,
) -> Result<()> {
    let metas = remaining_accounts
        .iter()
        .map(|account| {
            if account.is_writable {
                AccountMeta::new(*account.key, account.is_signer)
            } else {
                AccountMeta::new_readonly(*account.key, account.is_signer)
            }
        })
        .collect::<Vec<_>>();

    let instruction = Instruction {
        program_id: *program.key,
        accounts: metas,
        data: cpi_data,
    };

    let mut infos = remaining_accounts.to_vec();
    infos.push(program);
    invoke(&instruction, &infos).map_err(Into::into)
}
