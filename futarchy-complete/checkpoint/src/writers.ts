import { evm } from '@snapshot-labs/checkpoint';
import { createPublicClient, http } from 'viem';
import { gnosis } from 'viem/chains';
import { Aggregator, Organization, ProposalEntity, MetadataEntry } from '../.checkpoint/models';
import { AggregatorAbi, OrganizationAbi, ProposalMetadataAbi } from './abis';
import { rpcConfig } from './rpc-loader';

// Viem client for reading contract state
const client = createPublicClient({
    chain: gnosis,
    transport: http(rpcConfig.gnosis_rpc)
});

// Aggregator address constant (same as in config)
const AGGREGATOR_ADDRESS = '0xc5eb43d53e2fe5fdde5faf400cc4167e5b5d4fc1';
const INDEXER_NAME = 'gnosis';

// ============================================
// HELPERS
// ============================================

/**
 * Parse JSON metadata and create individual MetadataEntry entities
 * Mirrors the Graph Node updateMetadataEntries function
 */
async function updateMetadataEntries(
    parentId: string,
    parentType: 'Aggregator' | 'Organization' | 'Proposal',
    metadata: string | null | undefined,
    oldMetadata?: string | null
): Promise<void> {
    if (!metadata || metadata.length === 0) return;

    try {
        const jsonObj = JSON.parse(metadata);
        if (typeof jsonObj !== 'object' || jsonObj === null) return;

        const newKeys = new Set(Object.keys(jsonObj));

        // Delete stale keys that were in old metadata but not in new
        if (oldMetadata && oldMetadata.length > 0) {
            try {
                const oldJsonObj = JSON.parse(oldMetadata);
                if (typeof oldJsonObj === 'object' && oldJsonObj !== null) {
                    for (const oldKey of Object.keys(oldJsonObj)) {
                        if (!newKeys.has(oldKey)) {
                            const staleId = `${parentId}-${oldKey}`;
                            const staleEntry = await MetadataEntry.loadEntity(staleId, INDEXER_NAME);
                            if (staleEntry) {
                                // Nullify the parent reference to effectively orphan it
                                if (parentType === 'Aggregator') staleEntry.aggregator = null;
                                else if (parentType === 'Organization') staleEntry.organization = null;
                                else if (parentType === 'Proposal') staleEntry.proposal = null;
                                staleEntry.value = '';
                                await staleEntry.save();
                                console.log(`🧹 Removed stale metadata key: ${oldKey} for ${parentType} ${parentId}`);
                            }
                        }
                    }
                }
            } catch {
                // Old metadata parse failed, skip cleanup
            }
        }

        for (const [key, value] of Object.entries(jsonObj)) {
            // Convert value to string
            let strValue = '';
            if (typeof value === 'string') {
                strValue = value;
            } else if (typeof value === 'number') {
                strValue = value.toString();
            } else if (typeof value === 'boolean') {
                strValue = value ? 'true' : 'false';
            } else {
                // Skip nested objects/arrays
                continue;
            }

            const entryId = `${parentId}-${key}`;
            const entry = new MetadataEntry(entryId, INDEXER_NAME);
            entry.key = key;
            entry.value = strValue;

            if (parentType === 'Aggregator') {
                entry.aggregator = parentId;
            } else if (parentType === 'Organization') {
                entry.organization = parentId;
            } else if (parentType === 'Proposal') {
                entry.proposal = parentId;
            }

            await entry.save();
        }
    } catch (error) {
        // JSON parse failed, skip metadata entries
        console.log(`⚠️ Failed to parse metadata for ${parentType} ${parentId}`);
    }
}

// ============================================
// AGGREGATOR HANDLERS
// ============================================

export const handleOrganizationAdded: evm.Writer = async ({ event, blockNumber, source, helpers }) => {
    if (!event) return;

    const orgAddress = ((event as any).args?.organizationMetadata as string)?.toLowerCase();
    // Use source.contract if available, otherwise fall back to default aggregator
    const aggregatorId = source?.contract?.toLowerCase() || AGGREGATOR_ADDRESS;

    if (!orgAddress) return;

    try {
        // Read organization data from contract
        const [name, description, metadata, metadataURI, owner, editor] = await Promise.all([
            client.readContract({ address: orgAddress as `0x${string}`, abi: OrganizationAbi, functionName: 'companyName' }),
            client.readContract({ address: orgAddress as `0x${string}`, abi: OrganizationAbi, functionName: 'description' }),
            client.readContract({ address: orgAddress as `0x${string}`, abi: OrganizationAbi, functionName: 'metadata' }),
            client.readContract({ address: orgAddress as `0x${string}`, abi: OrganizationAbi, functionName: 'metadataURI' }),
            client.readContract({ address: orgAddress as `0x${string}`, abi: OrganizationAbi, functionName: 'owner' }),
            client.readContract({ address: orgAddress as `0x${string}`, abi: OrganizationAbi, functionName: 'editor' })
        ]);

        // Create Organization entity using generated model
        const org = new Organization(orgAddress, INDEXER_NAME);
        org.aggregator = aggregatorId;
        org.name = name as string;
        org.description = description as string;
        org.metadata = metadata as string;
        org.metadataURI = metadataURI as string;
        org.owner = (owner as string).toLowerCase();
        org.editor = (editor as string).toLowerCase();
        org.createdAt = Number(blockNumber);
        await org.save();

        // Create metadata entries from JSON metadata
        await updateMetadataEntries(orgAddress, 'Organization', metadata as string);

        // Start listening to the new organization
        await helpers.executeTemplate('Organization', {
            contract: orgAddress,
            start: blockNumber
        });

        console.log(`✅ Organization added: ${name} (${orgAddress}) -> aggregator: ${aggregatorId}`);
    } catch (error) {
        console.error(`❌ Failed to add organization ${orgAddress}:`, error);
    }
};


export const handleOrganizationCreated: evm.Writer = async ({ event, blockNumber, source, helpers }) => {
    if (!event) return;

    const args = (event as any).args;
    const orgAddress = (args?.organizationMetadata as string)?.toLowerCase();
    const companyName = args?.companyName;
    // Use source.contract or default aggregator
    const aggregatorId = source?.contract?.toLowerCase() || AGGREGATOR_ADDRESS;

    if (!orgAddress) return;

    try {
        // Read full organization data
        const [description, metadata, metadataURI, owner, editor] = await Promise.all([
            client.readContract({ address: orgAddress as `0x${string}`, abi: OrganizationAbi, functionName: 'description' }),
            client.readContract({ address: orgAddress as `0x${string}`, abi: OrganizationAbi, functionName: 'metadata' }),
            client.readContract({ address: orgAddress as `0x${string}`, abi: OrganizationAbi, functionName: 'metadataURI' }),
            client.readContract({ address: orgAddress as `0x${string}`, abi: OrganizationAbi, functionName: 'owner' }),
            client.readContract({ address: orgAddress as `0x${string}`, abi: OrganizationAbi, functionName: 'editor' })
        ]);

        const org = new Organization(orgAddress, INDEXER_NAME);
        org.aggregator = aggregatorId;
        org.name = companyName;
        org.description = description as string;
        org.metadata = metadata as string;
        org.metadataURI = metadataURI as string;
        org.owner = (owner as string).toLowerCase();
        org.editor = (editor as string).toLowerCase();
        org.createdAt = Number(blockNumber);
        await org.save();

        // Create metadata entries from JSON metadata
        await updateMetadataEntries(orgAddress, 'Organization', metadata as string);

        await helpers.executeTemplate('Organization', {
            contract: orgAddress,
            start: blockNumber
        });

        console.log(`✅ Organization created: ${companyName} (${orgAddress})`);
    } catch (error) {
        console.error(`❌ Failed to create organization ${orgAddress}:`, error);
    }
};

export const handleOrganizationRemoved: evm.Writer = async ({ event }) => {
    if (!event) return;
    const orgAddress = ((event as any).args?.organizationMetadata as string)?.toLowerCase();
    if (!orgAddress) return;

    const org = await Organization.loadEntity(orgAddress, INDEXER_NAME);
    if (org) {
        org.aggregator = null;
        await org.save();
        console.log(`🗑️ Organization removed (aggregator nullified): ${orgAddress}`);
    } else {
        console.log(`🗑️ Organization removed (not found): ${orgAddress}`);
    }
};

// ============================================
// CREATOR (AGGREGATOR FACTORY) HANDLERS
// ============================================

/**
 * Handles AggregatorMetadataCreated events from the Creator (factory) contract.
 * Creates Aggregator entities and starts listening for aggregator events.
 * Mirrors the graph-node handleAggregatorCreated handler.
 */
export const handleAggregatorCreated: evm.Writer = async ({ event, blockNumber, helpers }) => {
    if (!event) return;

    const args = (event as any).args;
    const aggregatorAddress = (args?.metadata as string)?.toLowerCase();
    const aggregatorName = args?.name as string;

    if (!aggregatorAddress) return;

    try {
        const [description, metadata, metadataURI, owner] = await Promise.all([
            client.readContract({ address: aggregatorAddress as `0x${string}`, abi: AggregatorAbi, functionName: 'description' }),
            client.readContract({ address: aggregatorAddress as `0x${string}`, abi: AggregatorAbi, functionName: 'metadata' }),
            client.readContract({ address: aggregatorAddress as `0x${string}`, abi: AggregatorAbi, functionName: 'metadataURI' }),
            client.readContract({ address: aggregatorAddress as `0x${string}`, abi: AggregatorAbi, functionName: 'owner' })
        ]);

        const agg = new Aggregator(aggregatorAddress, INDEXER_NAME);
        agg.name = aggregatorName || '';
        agg.description = (description as string) || '';
        agg.metadata = (metadata as string) || '';
        agg.metadataURI = (metadataURI as string) || '';
        agg.creator = (event as any).transaction?.from?.toLowerCase() || '';
        agg.owner = ((owner as string) || '').toLowerCase();
        agg.createdAt = Number(blockNumber);
        await agg.save();

        // Create metadata entries from JSON metadata
        await updateMetadataEntries(aggregatorAddress, 'Aggregator', metadata as string);

        console.log(`✅ Aggregator created: ${aggregatorName} (${aggregatorAddress})`);
    } catch (error) {
        console.error(`❌ Failed to create aggregator ${aggregatorAddress}:`, error);
    }
};

export const handleAggregatorInfoUpdated: evm.Writer = async ({ event, source }) => {
    const args = (event as any)?.args;
    const aggregatorAddress = source?.contract?.toLowerCase() || AGGREGATOR_ADDRESS;

    if (args?.newName && aggregatorAddress) {
        const agg = await Aggregator.loadEntity(aggregatorAddress, INDEXER_NAME);
        if (agg) {
            agg.name = args.newName;
            agg.description = args.newDescription || agg.description;
            await agg.save();
        }
    }
    console.log(`📝 Aggregator info updated: ${args?.newName}`);
};

export const handleAggregatorMetadataUpdated: evm.Writer = async ({ event, source }) => {
    const args = (event as any)?.args;
    const aggregatorAddress = source?.contract?.toLowerCase() || AGGREGATOR_ADDRESS;

    if (aggregatorAddress) {
        const agg = await Aggregator.loadEntity(aggregatorAddress, INDEXER_NAME);
        if (agg) {
            const oldMetadata = agg.metadata;
            const metadataStr = args?.metadata || '';
            agg.metadata = metadataStr;
            agg.metadataURI = args?.metadataURI || '';
            await agg.save();

            await updateMetadataEntries(aggregatorAddress, 'Aggregator', metadataStr, oldMetadata);
        }
    }
    console.log(`📦 Aggregator metadata updated`);
};

export const handleAggregatorEditorSet: evm.Writer = async ({ event, source }) => {
    const args = (event as any)?.args;
    const aggregatorAddress = source?.contract?.toLowerCase() || AGGREGATOR_ADDRESS;

    if (aggregatorAddress && args?.newEditor) {
        const agg = await Aggregator.loadEntity(aggregatorAddress, INDEXER_NAME);
        if (agg) {
            agg.editor = args.newEditor.toLowerCase();
            await agg.save();
        }
    }
    console.log(`✏️ Aggregator editor set: ${args?.newEditor}`);
};

export const handleAggregatorEditorRevoked: evm.Writer = async ({ event, source }) => {
    const aggregatorAddress = source?.contract?.toLowerCase() || AGGREGATOR_ADDRESS;

    if (aggregatorAddress) {
        const agg = await Aggregator.loadEntity(aggregatorAddress, INDEXER_NAME);
        if (agg) {
            agg.editor = null;
            await agg.save();
        }
    }
    console.log(`🚫 Aggregator editor revoked`);
};

export const handleAggregatorOwnershipTransferred: evm.Writer = async ({ event, source }) => {
    const args = (event as any)?.args;
    const aggregatorAddress = source?.contract?.toLowerCase() || AGGREGATOR_ADDRESS;

    if (aggregatorAddress && args?.newOwner) {
        const agg = await Aggregator.loadEntity(aggregatorAddress, INDEXER_NAME);
        if (agg) {
            agg.owner = args.newOwner.toLowerCase();
            await agg.save();
        }
    }
    console.log(`👑 Aggregator owner transferred: ${args?.newOwner}`);
};

// ============================================
// PROPOSAL METADATA FACTORY HANDLERS
// ============================================

/**
 * Handles ProposalMetadataCreated events directly from the factory.
 * This ensures ALL proposals are indexed, not just those captured via org templates.
 */
export const handleProposalMetadataFactoryCreated: evm.Writer = async ({ event, blockNumber, helpers }) => {
    if (!event) return;

    const args = (event as any).args;
    const metadataAddress = (args?.metadata as string)?.toLowerCase();
    const tradingAddress = (args?.proposalAddress as string)?.toLowerCase();

    if (!metadataAddress) return;

    try {
        // Check if proposal already exists (may have been created via org template)
        const existing = await ProposalEntity.loadEntity(metadataAddress, INDEXER_NAME);
        if (existing) {
            console.log(`⏭️ Proposal already exists: ${metadataAddress?.slice(0, 10)}...`);
            return;
        }

        // Read proposal data from contract
        const [title, displayNameEvent, description, metadata, metadataURI, owner, editor] = await Promise.all([
            client.readContract({ address: metadataAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'displayNameQuestion' }),
            client.readContract({ address: metadataAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'displayNameEvent' }),
            client.readContract({ address: metadataAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'description' }),
            client.readContract({ address: metadataAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'metadata' }),
            client.readContract({ address: metadataAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'metadataURI' }),
            client.readContract({ address: metadataAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'owner' }),
            client.readContract({ address: metadataAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'editor' })
        ]);

        const proposal = new ProposalEntity(metadataAddress, INDEXER_NAME);
        proposal.organization = null; // Will be set when ProposalAdded event is processed
        proposal.owner = (owner as string).toLowerCase();
        proposal.editor = (editor as string).toLowerCase();
        proposal.proposalAddress = tradingAddress;
        proposal.title = title as string;
        proposal.description = description as string;
        proposal.metadata = metadata as string;
        proposal.metadataURI = metadataURI as string;
        proposal.displayNameEvent = displayNameEvent as string;
        proposal.displayNameQuestion = title as string;
        proposal.createdAtTimestamp = Number(blockNumber);
        await proposal.save();

        // Create metadata entries from JSON metadata
        await updateMetadataEntries(metadataAddress, 'Proposal', metadata as string);

        // Start listening to proposal metadata updates
        await helpers.executeTemplate('ProposalMetadata', {
            contract: metadataAddress,
            start: blockNumber
        });

        console.log(`🏭 Factory: Proposal created: ${(title as string)?.slice(0, 50)}...`);
    } catch (error) {
        console.error(`❌ Factory: Failed to create proposal ${metadataAddress}:`, error);
    }
};

// ============================================
// ORGANIZATION HANDLERS
// ============================================

export const handleProposalAdded: evm.Writer = async ({ event, blockNumber, source, helpers }) => {
    if (!event) return;

    const proposalAddress = ((event as any).args?.proposalMetadata as string)?.toLowerCase();
    const orgAddress = source?.contract.toLowerCase();

    if (!proposalAddress) return;

    try {
        // Read proposal data from contract
        const [tradingAddress, title, displayNameEvent, description, metadata, metadataURI, owner, editor] = await Promise.all([
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'proposalAddress' }),
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'displayNameQuestion' }),
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'displayNameEvent' }),
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'description' }),
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'metadata' }),
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'metadataURI' }),
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'owner' }),
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'editor' })
        ]);

        const proposal = new ProposalEntity(proposalAddress, INDEXER_NAME);
        proposal.organization = orgAddress || null;
        proposal.owner = (owner as string).toLowerCase();
        proposal.editor = (editor as string).toLowerCase();
        proposal.proposalAddress = (tradingAddress as string).toLowerCase();
        proposal.title = title as string;
        proposal.description = description as string;
        proposal.metadata = metadata as string;
        proposal.metadataURI = metadataURI as string;
        proposal.displayNameEvent = displayNameEvent as string;
        proposal.displayNameQuestion = title as string;
        proposal.createdAtTimestamp = Number(blockNumber);
        await proposal.save();

        // Create metadata entries from JSON metadata
        await updateMetadataEntries(proposalAddress, 'Proposal', metadata as string);

        await helpers.executeTemplate('ProposalMetadata', {
            contract: proposalAddress,
            start: blockNumber
        });

        console.log(`✅ Proposal added: ${(title as string)?.slice(0, 50)}...`);
    } catch (error) {
        console.error(`❌ Failed to add proposal ${proposalAddress}:`, error);
    }
};

export const handleProposalCreated: evm.Writer = async ({ event, blockNumber, source, helpers }) => {
    if (!event) return;

    const args = (event as any).args;
    const proposalAddress = (args?.proposalMetadata as string)?.toLowerCase();
    const tradingAddress = (args?.proposalAddress as string)?.toLowerCase(); // Get from event, not contract
    const orgAddress = source?.contract.toLowerCase();

    if (!proposalAddress) return;

    try {
        const [title, displayNameEvent, description, metadata, metadataURI, owner, editor] = await Promise.all([
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'displayNameQuestion' }),
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'displayNameEvent' }),
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'description' }),
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'metadata' }),
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'metadataURI' }),
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'owner' }),
            client.readContract({ address: proposalAddress as `0x${string}`, abi: ProposalMetadataAbi, functionName: 'editor' })
        ]);

        const proposal = new ProposalEntity(proposalAddress, INDEXER_NAME);
        proposal.organization = orgAddress || null;
        proposal.owner = (owner as string).toLowerCase();
        proposal.editor = (editor as string).toLowerCase();
        proposal.proposalAddress = tradingAddress || (proposalAddress as string); // Use event arg or fallback
        proposal.title = title as string;
        proposal.description = description as string;
        proposal.metadata = metadata as string;
        proposal.metadataURI = metadataURI as string;
        proposal.displayNameEvent = displayNameEvent as string;
        proposal.displayNameQuestion = title as string;
        proposal.createdAtTimestamp = Number(blockNumber);
        await proposal.save();

        // Create metadata entries from JSON metadata
        await updateMetadataEntries(proposalAddress, 'Proposal', metadata as string);

        await helpers.executeTemplate('ProposalMetadata', {
            contract: proposalAddress,
            start: blockNumber
        });

        console.log(`✅ Proposal created: ${(title as string)?.slice(0, 50)}...`);
    } catch (error) {
        console.error(`❌ Failed to create proposal ${proposalAddress}:`, error);
    }
};

export const handleProposalRemoved: evm.Writer = async ({ event }) => {
    if (!event) return;
    const proposalAddress = ((event as any).args?.proposalMetadata as string)?.toLowerCase();
    if (!proposalAddress) return;

    const proposal = await ProposalEntity.loadEntity(proposalAddress, INDEXER_NAME);
    if (proposal) {
        proposal.organization = null;
        await proposal.save();
        console.log(`🗑️ Proposal removed (organization nullified): ${proposalAddress}`);
    } else {
        console.log(`🗑️ Proposal removed (not found): ${proposalAddress}`);
    }
};

export const handleOrganizationInfoUpdated: evm.Writer = async ({ event, source }) => {
    const args = (event as any)?.args;
    const orgAddress = source?.contract.toLowerCase();

    if (args?.newName && orgAddress) {
        const org = await Organization.loadEntity(orgAddress, INDEXER_NAME);
        if (org) {
            org.name = args.newName;
            org.description = args.newDescription || '';
            await org.save();
            console.log(`📝 Organization info updated: ${args.newName}`);
        }
    }
};

export const handleOrganizationMetadataUpdated: evm.Writer = async ({ event, source }) => {
    const args = (event as any)?.args;
    const orgAddress = source?.contract.toLowerCase();

    if (orgAddress) {
        const org = await Organization.loadEntity(orgAddress, INDEXER_NAME);
        if (org) {
            const oldMetadata = org.metadata;
            const metadataStr = args?.metadata || '';
            org.metadata = metadataStr;
            org.metadataURI = args?.metadataURI || '';
            await org.save();

            // Create metadata entries from JSON metadata (with stale key cleanup)
            await updateMetadataEntries(orgAddress, 'Organization', metadataStr, oldMetadata);
        }
    }
    console.log(`📦 Organization metadata updated`);
};

export const handleOrganizationEditorSet: evm.Writer = async ({ event, source }) => {
    const args = (event as any)?.args;
    const orgAddress = source?.contract.toLowerCase();

    if (orgAddress && args?.newEditor) {
        const org = await Organization.loadEntity(orgAddress, INDEXER_NAME);
        if (org) {
            org.editor = args.newEditor.toLowerCase();
            await org.save();
        }
    }
    console.log(`✏️ Organization editor set: ${args?.newEditor}`);
};

export const handleOrganizationEditorRevoked: evm.Writer = async ({ event, source }) => {
    const orgAddress = source?.contract.toLowerCase();

    if (orgAddress) {
        const org = await Organization.loadEntity(orgAddress, INDEXER_NAME);
        if (org) {
            org.editor = null;
            await org.save();
        }
    }
    console.log(`🚫 Organization editor revoked`);
};

export const handleOrganizationOwnershipTransferred: evm.Writer = async ({ event, source }) => {
    const args = (event as any)?.args;
    const orgAddress = source?.contract.toLowerCase();

    if (orgAddress && args?.newOwner) {
        const org = await Organization.loadEntity(orgAddress, INDEXER_NAME);
        if (org) {
            org.owner = args.newOwner.toLowerCase();
            await org.save();
        }
    }
    console.log(`👑 Organization owner transferred: ${args?.newOwner}`);
};

// ============================================
// PROPOSAL HANDLERS
// ============================================

export const handleProposalInfoUpdated: evm.Writer = async ({ event, source }) => {
    const args = (event as any)?.args;
    const proposalAddress = source?.contract.toLowerCase();

    if (proposalAddress) {
        const proposal = await ProposalEntity.loadEntity(proposalAddress, INDEXER_NAME);
        if (proposal) {
            proposal.title = args?.displayNameQuestion || '';
            proposal.displayNameEvent = args?.displayNameEvent || '';
            proposal.description = args?.description || '';
            await proposal.save();
        }
    }
    console.log(`📝 Proposal info updated`);
};

export const handleProposalMetadataUpdated: evm.Writer = async ({ event, source }) => {
    const args = (event as any)?.args;
    const proposalAddress = source?.contract.toLowerCase();

    if (proposalAddress) {
        const proposal = await ProposalEntity.loadEntity(proposalAddress, INDEXER_NAME);
        if (proposal) {
            const oldMetadata = proposal.metadata;
            const metadataStr = args?.metadata || '';
            proposal.metadata = metadataStr;
            proposal.metadataURI = args?.metadataURI || '';
            await proposal.save();

            // Create metadata entries from JSON metadata (with stale key cleanup)
            await updateMetadataEntries(proposalAddress, 'Proposal', metadataStr, oldMetadata);
        }
    }
    console.log(`📦 Proposal metadata updated`);
};

export const handleProposalEditorSet: evm.Writer = async ({ event, source }) => {
    const args = (event as any)?.args;
    const proposalAddress = source?.contract.toLowerCase();

    if (proposalAddress && args?.newEditor) {
        const proposal = await ProposalEntity.loadEntity(proposalAddress, INDEXER_NAME);
        if (proposal) {
            proposal.editor = args.newEditor.toLowerCase();
            await proposal.save();
        }
    }
    console.log(`✏️ Proposal editor set: ${args?.newEditor}`);
};

export const handleProposalEditorRevoked: evm.Writer = async ({ event, source }) => {
    const proposalAddress = source?.contract.toLowerCase();

    if (proposalAddress) {
        const proposal = await ProposalEntity.loadEntity(proposalAddress, INDEXER_NAME);
        if (proposal) {
            proposal.editor = null;
            await proposal.save();
        }
    }
    console.log(`🚫 Proposal editor revoked`);
};

export const handleProposalOwnershipTransferred: evm.Writer = async ({ event, source }) => {
    const args = (event as any)?.args;
    const proposalAddress = source?.contract.toLowerCase();

    if (proposalAddress && args?.newOwner) {
        const proposal = await ProposalEntity.loadEntity(proposalAddress, INDEXER_NAME);
        if (proposal) {
            proposal.owner = args.newOwner.toLowerCase();
            await proposal.save();
        }
    }
    console.log(`👑 Proposal owner transferred: ${args?.newOwner}`);
};

// Export all writers
export const writers = {
    handleOrganizationAdded,
    handleOrganizationCreated,
    handleOrganizationRemoved,
    handleAggregatorCreated,
    handleAggregatorInfoUpdated,
    handleAggregatorMetadataUpdated,
    handleAggregatorEditorSet,
    handleAggregatorEditorRevoked,
    handleProposalMetadataFactoryCreated,
    handleProposalAdded,
    handleProposalCreated,
    handleProposalRemoved,
    handleOrganizationInfoUpdated,
    handleOrganizationMetadataUpdated,
    handleOrganizationEditorSet,
    handleOrganizationEditorRevoked,
    handleProposalInfoUpdated,
    handleProposalMetadataUpdated,
    handleProposalEditorSet,
    handleProposalEditorRevoked,
    handleAggregatorOwnershipTransferred,
    handleOrganizationOwnershipTransferred,
    handleProposalOwnershipTransferred
};
