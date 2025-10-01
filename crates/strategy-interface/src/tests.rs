use super::*;

#[test]
fn test_strategy_state_size() {
    assert_eq!(StrategyState::SIZE, 32 + 1 + 32 + 32 + 8 + 8 + 8 + 1 + 1);
}

#[test]
fn test_strategy_kind_values() {
    assert_eq!(StrategyKind::Marinade as u8, 0);
    assert_eq!(StrategyKind::Lido as u8, 1);
    assert_eq!(StrategyKind::Mock as u8, 255);
}

#[test]
fn test_strategy_kind_serialization() {
    let marinade = StrategyKind::Marinade;
    let lido = StrategyKind::Lido;
    let mock = StrategyKind::Mock;

    assert_eq!(marinade as u8, 0);
    assert_eq!(lido as u8, 1);
    assert_eq!(mock as u8, 255);
}

#[test]
fn test_initialize_args_serialization() {
    use anchor_lang::prelude::*;
    
    let args = InitializeArgs {
        kind: 255,
        protocol_program: Pubkey::default(),
        position_mint: Pubkey::default(),
    };

    let serialized = args.try_to_vec().unwrap();
    let deserialized = InitializeArgs::try_from_slice(&serialized).unwrap();
    
    assert_eq!(args.kind, deserialized.kind);
    assert_eq!(args.protocol_program, deserialized.protocol_program);
    assert_eq!(args.position_mint, deserialized.position_mint);
}

#[test]
fn test_stake_args_serialization() {
    let args = StakeArgs { amount: 1000000 };
    let serialized = args.try_to_vec().unwrap();
    let deserialized = StakeArgs::try_from_slice(&serialized).unwrap();
    
    assert_eq!(args.amount, deserialized.amount);
}

#[test]
fn test_unstake_args_serialization() {
    let args = UnstakeArgs { amount: 500000 };
    let serialized = args.try_to_vec().unwrap();
    let deserialized = UnstakeArgs::try_from_slice(&serialized).unwrap();
    
    assert_eq!(args.amount, deserialized.amount);
}
