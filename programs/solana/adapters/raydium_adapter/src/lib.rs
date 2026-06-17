use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash::hashv,
    instruction::{AccountMeta, Instruction},
    program::invoke,
};

declare_id!("3NfaLqhgf4uK8ZDJXpoqZMZkXaRPBagRS5AfLhKcBBbw");

const MAX_MEMO_LEN: usize = 160;
const RAYDIUM_SWAP_BASE_INPUT_TAGS: [&[u8]; 1] = [b"global:swap_base_input"];
const RAYDIUM_SWAP_BASE_OUTPUT_TAGS: [&[u8]; 1] = [b"global:swap_base_output"];
const RAYDIUM_DEPOSIT_TAGS: [&[u8]; 1] = [b"global:deposit"];
const RAYDIUM_WITHDRAW_TAGS: [&[u8]; 1] = [b"global:withdraw"];
const RAYDIUM_INITIALIZE_TAGS: [&[u8]; 2] = [b"global:initialize", b"global:initialize_pool"];

#[program]
pub mod raydium_adapter {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        raydium_program: Pubkey,
        executor: Pubkey,
        permissionless: bool,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.executor = executor;
        config.raydium_program = raydium_program;
        config.permissionless = permissionless;
        config.paused = false;
        config.bump = ctx.bumps.config;
        emit!(RaydiumAdapterConfigured {
            admin: config.admin,
            executor,
            raydium_program,
            permissionless,
        });
        Ok(())
    }

    pub fn set_executor(ctx: Context<AdminOnly>, executor: Pubkey) -> Result<()> {
        ctx.accounts.config.executor = executor;
        emit!(RaydiumExecutorUpdated { executor });
        Ok(())
    }

    pub fn set_raydium_program(ctx: Context<AdminOnly>, raydium_program: Pubkey) -> Result<()> {
        ctx.accounts.config.raydium_program = raydium_program;
        emit!(RaydiumProgramUpdated { raydium_program });
        Ok(())
    }

    pub fn set_permissionless(ctx: Context<AdminOnly>, permissionless: bool) -> Result<()> {
        ctx.accounts.config.permissionless = permissionless;
        emit!(RaydiumPermissionlessUpdated { permissionless });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(RaydiumPausedUpdated { paused });
        Ok(())
    }

    /// Executes a vetted Raydium CPMM/CP-Swap instruction via CPI.
    ///
    /// The off-chain executor resolves pool state, vaults, token accounts, amm config,
    /// observation/oracle accounts, and slippage using the Raydium SDK. This adapter
    /// verifies the Raydium program id and Anchor instruction discriminator before
    /// forwarding the CPI and recording a per-intent receipt.
    pub fn execute<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteRaydium<'info>>,
        intent_id: [u8; 32],
        action: RaydiumAction,
        amount_in: u64,
        limit_amount: u64,
        cpi_data: Vec<u8>,
        memo: String,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, RaydiumAdapterError::Paused);
        require!(memo.as_bytes().len() <= MAX_MEMO_LEN, RaydiumAdapterError::MemoTooLong);
        require_authorized(config, ctx.accounts.authority.key())?;
        require_keys_eq!(ctx.accounts.raydium_program.key(), config.raydium_program, RaydiumAdapterError::WrongProgram);
        validate_raydium_discriminator(action, &cpi_data)?;

        forward_to_program(
            ctx.accounts.raydium_program.to_account_info(),
            ctx.remaining_accounts,
            cpi_data,
        )?;

        let receipt = &mut ctx.accounts.receipt;
        receipt.intent_id = intent_id;
        receipt.executor = ctx.accounts.authority.key();
        receipt.action = action.code();
        receipt.amount_in = amount_in;
        receipt.limit_amount = limit_amount;
        receipt.protocol_program = ctx.accounts.raydium_program.key();
        receipt.created_at = Clock::get()?.unix_timestamp;
        receipt.memo = memo;

        emit!(RaydiumIntentExecuted {
            intent_id,
            executor: receipt.executor,
            action: receipt.action,
            amount_in,
            limit_amount,
            protocol_program: receipt.protocol_program,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = AdapterConfig::SPACE, seeds = [b"raydium-config"], bump)]
    pub config: Account<'info, AdapterConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"raydium-config"], bump = config.bump, has_one = admin @ RaydiumAdapterError::Unauthorized)]
    pub config: Account<'info, AdapterConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(intent_id: [u8; 32])]
pub struct ExecuteRaydium<'info> {
    #[account(mut, seeds = [b"raydium-config"], bump = config.bump)]
    pub config: Account<'info, AdapterConfig>,
    #[account(
        init,
        payer = authority,
        space = AdapterReceipt::SPACE,
        seeds = [b"raydium-receipt", intent_id.as_ref()],
        bump
    )]
    pub receipt: Account<'info, AdapterReceipt>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: address is checked against config.raydium_program before CPI.
    pub raydium_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct AdapterConfig {
    pub admin: Pubkey,
    pub executor: Pubkey,
    pub raydium_program: Pubkey,
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
    /// Encoded RaydiumAction code for cheap indexing in explorers/indexers.
    pub action: u8,
    pub amount_in: u64,
    /// For swaps this is minimum output or maximum input depending on exact-in/exact-out.
    /// For liquidity actions it is the paired token or lp-token limit chosen by the executor.
    pub limit_amount: u64,
    pub protocol_program: Pubkey,
    pub created_at: i64,
    pub memo: String,
}

impl AdapterReceipt {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 8 + 8 + 32 + 8 + 4 + MAX_MEMO_LEN;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RaydiumAction {
    SwapBaseInput,
    SwapBaseOutput,
    Deposit,
    Withdraw,
    InitializePool,
}

impl RaydiumAction {
    pub fn code(self) -> u8 {
        match self {
            Self::SwapBaseInput => 1,
            Self::SwapBaseOutput => 2,
            Self::Deposit => 3,
            Self::Withdraw => 4,
            Self::InitializePool => 5,
        }
    }
}

#[event]
pub struct RaydiumAdapterConfigured {
    pub admin: Pubkey,
    pub executor: Pubkey,
    pub raydium_program: Pubkey,
    pub permissionless: bool,
}

#[event]
pub struct RaydiumExecutorUpdated {
    pub executor: Pubkey,
}

#[event]
pub struct RaydiumProgramUpdated {
    pub raydium_program: Pubkey,
}

#[event]
pub struct RaydiumPermissionlessUpdated {
    pub permissionless: bool,
}

#[event]
pub struct RaydiumPausedUpdated {
    pub paused: bool,
}

#[event]
pub struct RaydiumIntentExecuted {
    pub intent_id: [u8; 32],
    pub executor: Pubkey,
    pub action: u8,
    pub amount_in: u64,
    pub limit_amount: u64,
    pub protocol_program: Pubkey,
}

#[error_code]
pub enum RaydiumAdapterError {
    #[msg("adapter is paused")]
    Paused,
    #[msg("caller is not authorized")]
    Unauthorized,
    #[msg("target program is not the configured Raydium program")]
    WrongProgram,
    #[msg("CPI data is shorter than an Anchor discriminator")]
    CpiDataTooShort,
    #[msg("CPI instruction discriminator is not allowed for this Raydium action")]
    DiscriminatorNotAllowed,
    #[msg("memo exceeds adapter maximum length")]
    MemoTooLong,
}

fn require_authorized(config: &AdapterConfig, caller: Pubkey) -> Result<()> {
    if config.permissionless || caller == config.admin || caller == config.executor {
        Ok(())
    } else {
        err!(RaydiumAdapterError::Unauthorized)
    }
}

fn validate_raydium_discriminator(action: RaydiumAction, cpi_data: &[u8]) -> Result<()> {
    require!(cpi_data.len() >= 8, RaydiumAdapterError::CpiDataTooShort);
    let tags = match action {
        RaydiumAction::SwapBaseInput => &RAYDIUM_SWAP_BASE_INPUT_TAGS[..],
        RaydiumAction::SwapBaseOutput => &RAYDIUM_SWAP_BASE_OUTPUT_TAGS[..],
        RaydiumAction::Deposit => &RAYDIUM_DEPOSIT_TAGS[..],
        RaydiumAction::Withdraw => &RAYDIUM_WITHDRAW_TAGS[..],
        RaydiumAction::InitializePool => &RAYDIUM_INITIALIZE_TAGS[..],
    };

    for tag in tags {
        let hash = hashv(&[*tag]).to_bytes();
        if cpi_data[..8] == hash[..8] {
            return Ok(());
        }
    }
    err!(RaydiumAdapterError::DiscriminatorNotAllowed)
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
