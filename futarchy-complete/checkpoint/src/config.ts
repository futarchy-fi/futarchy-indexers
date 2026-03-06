import { CheckpointConfig } from '@snapshot-labs/checkpoint';
import { AggregatorAbi, CreatorAbi, OrganizationAbi, ProposalMetadataAbi, ProposalMetadataFactoryAbi } from './abis';
import { rpcConfig } from './rpc-loader';

// Gnosis Chain contract addresses
const AGGREGATOR_ADDRESS = '0xC5eB43D53e2FE5FddE5faf400CC4167e5b5d4Fc1';
const AGGREGATOR_START_BLOCK = 44220000;

// Creator (Aggregator Factory) - creates Aggregator entities
const CREATOR_ADDRESS = '0xe7C27c932C80D30c9aaA30A856c0062208d269b4';
const CREATOR_START_BLOCK = 44220000;

// ProposalMetadataFactory - directly indexes all proposal creations
const PROPOSAL_FACTORY_ADDRESS = '0x899c70C37E523C99Bd61993ca434F1c1A82c106d';
const PROPOSAL_FACTORY_START_BLOCK = 44220000;

export const config: CheckpointConfig = {
    network_node_url: rpcConfig.gnosis_rpc,

    sources: [
        // Creator (Aggregator Factory) - creates Aggregator entities when new aggregators are deployed
        {
            contract: CREATOR_ADDRESS,
            abi: 'Creator',
            start: CREATOR_START_BLOCK,
            events: [
                { name: 'AggregatorMetadataCreated(address,string)', fn: 'handleAggregatorCreated' }
            ]
        },
        {
            contract: AGGREGATOR_ADDRESS,
            abi: 'Aggregator',
            start: AGGREGATOR_START_BLOCK,
            events: [
                { name: 'OrganizationAdded(address)', fn: 'handleOrganizationAdded' },
                { name: 'OrganizationCreatedAndAdded(address,string)', fn: 'handleOrganizationCreated' },
                { name: 'OrganizationRemoved(address)', fn: 'handleOrganizationRemoved' },
                { name: 'AggregatorInfoUpdated(string,string)', fn: 'handleAggregatorInfoUpdated' },
                { name: 'ExtendedMetadataUpdated(string,string)', fn: 'handleAggregatorMetadataUpdated' },
                { name: 'EditorSet(address)', fn: 'handleAggregatorEditorSet' },
                { name: 'EditorRevoked(address)', fn: 'handleAggregatorEditorRevoked' },
                { name: 'OwnershipTransferred(address,address)', fn: 'handleAggregatorOwnershipTransferred' }
            ]
        },
        // ProposalMetadataFactory - captures ALL proposal creations directly (not via templates)
        {
            contract: PROPOSAL_FACTORY_ADDRESS,
            abi: 'ProposalMetadataFactory',
            start: PROPOSAL_FACTORY_START_BLOCK,
            events: [
                { name: 'ProposalMetadataCreated(address,address)', fn: 'handleProposalMetadataFactoryCreated' }
            ]
        }
    ],

    // Dynamic templates for orgs created via factory
    templates: {
        Organization: {
            abi: 'Organization',
            events: [
                { name: 'ProposalAdded(address)', fn: 'handleProposalAdded' },
                { name: 'ProposalCreatedAndAdded(address,address)', fn: 'handleProposalCreated' },
                { name: 'ProposalRemoved(address)', fn: 'handleProposalRemoved' },
                { name: 'OrganizationInfoUpdated(string,string)', fn: 'handleOrganizationInfoUpdated' },
                { name: 'ExtendedMetadataUpdated(string,string)', fn: 'handleOrganizationMetadataUpdated' },
                { name: 'EditorSet(address)', fn: 'handleOrganizationEditorSet' },
                { name: 'EditorRevoked(address)', fn: 'handleOrganizationEditorRevoked' },
                { name: 'OwnershipTransferred(address,address)', fn: 'handleOrganizationOwnershipTransferred' }
            ]
        },
        ProposalMetadata: {
            abi: 'ProposalMetadata',
            events: [
                { name: 'ProposalInfoUpdated(string,string,string)', fn: 'handleProposalInfoUpdated' },
                { name: 'ExtendedMetadataUpdated(string,string)', fn: 'handleProposalMetadataUpdated' },
                { name: 'EditorSet(address)', fn: 'handleProposalEditorSet' },
                { name: 'EditorRevoked(address)', fn: 'handleProposalEditorRevoked' },
                { name: 'OwnershipTransferred(address,address)', fn: 'handleProposalOwnershipTransferred' }
            ]
        }
    },

    abis: {
        Aggregator: AggregatorAbi,
        Creator: CreatorAbi,
        Organization: OrganizationAbi,
        ProposalMetadata: ProposalMetadataAbi,
        ProposalMetadataFactory: ProposalMetadataFactoryAbi
    }
};
