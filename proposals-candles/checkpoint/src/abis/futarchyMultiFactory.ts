// FutarchyMultiFactory ABI - event for multi-option proposal creation
export const FutarchyMultiFactoryAbi = [
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: 'address', name: 'proposal', type: 'address' },
            { indexed: false, internalType: 'string', name: 'marketName', type: 'string' },
            { indexed: false, internalType: 'bytes32', name: 'conditionId', type: 'bytes32' },
            { indexed: false, internalType: 'bytes32', name: 'questionId', type: 'bytes32' },
            { indexed: true, internalType: 'address', name: 'parentMarket', type: 'address' },
            { indexed: false, internalType: 'uint256', name: 'parentOutcome', type: 'uint256' }
        ],
        name: 'NewMultiProposal',
        type: 'event'
    }
] as const;
