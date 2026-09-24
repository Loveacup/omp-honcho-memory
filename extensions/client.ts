import { Honcho } from "@honcho-ai/sdk";
import type { HonchoExtensionConfig } from "./config.js";

export type SessionKey = string;

export interface HonchoMessage {
	peerId: string;
	content: string;
	metadata?: Record<string, unknown>;
	createdAt?: string;
}

export interface HonchoConclusion {
	id: string;
	content: string;
	observerId: string;
	observedId: string;
}

export interface HonchoConclusionView {
	create(params: { content: string; sessionId?: string }): Promise<unknown>;
	get(id: string): Promise<HonchoConclusion>;
	list(options?: { size?: number }): Promise<{ items?: HonchoConclusion[] }>;
	delete(id: string): Promise<unknown>;
}

export interface HonchoPeer {
	id: string;
	message(content: string, options?: { metadata?: Record<string, unknown>; createdAt?: string }): HonchoMessage;
	context(options?: {
		target?: string | HonchoPeer;
		searchQuery?: string;
		searchTopK?: number;
		searchMaxDistance?: number;
		maxConclusions?: number;
		includeMostFrequent?: boolean;
	}): Promise<{ representation: string; peerCard: string[] | null }>;
	conclusionsOf(targetPeer: HonchoPeer): HonchoConclusionView;
	chat(
		query: string,
		options?: { target?: HonchoPeer; session?: HonchoSession; reasoningLevel?: string },
	): Promise<string | null>;
}

export interface HonchoSession {
	id: string;
	addMessages(messages: HonchoMessage[]): Promise<unknown>;
	addPeers(peers: [string, { observeMe: boolean; observeOthers: boolean }][]): Promise<unknown>;
	summaries(): Promise<{ shortSummary?: string; longSummary?: string }>;
	context(options?: {
		summary?: boolean;
		peerPerspective?: HonchoPeer;
		peerTarget?: HonchoPeer;
		limitToSession?: boolean;
		representationOptions?: {
			searchQuery?: string;
			searchTopK?: number;
			searchMaxDistance?: number;
			maxConclusions?: number;
		};
	}): Promise<{ summary?: string; peerRepresentation?: string }>;
	search(query: string, options?: unknown): Promise<unknown[]>;
}

export interface HonchoHandles {
	honcho: Honcho;
	workspaceId: string;
	sessionId: SessionKey;
	userPeerId: string;
	aiPeerId: string;
	userPeerName: string;
	aiPeerName: string;
	userPeer: HonchoPeer;
	aiPeer: HonchoPeer;
	session: HonchoSession;
	config: HonchoExtensionConfig;
}

export function userConclusionObserver(handles: HonchoHandles): HonchoPeer {
	return handles.config.observationMode === "unified" ? handles.userPeer : handles.aiPeer;
}

export function userConclusionView(handles: HonchoHandles): HonchoConclusionView {
	return userConclusionObserver(handles).conclusionsOf(handles.userPeer);
}

export async function createHonchoHandles(params: {
	config: HonchoExtensionConfig;
	sessionKey: SessionKey;
}): Promise<HonchoHandles> {
	const honcho = new Honcho({
		apiKey: params.config.apiKey || undefined,
		baseURL: params.config.url || undefined,
		workspaceId: params.config.workspace,
	});

	// Peer IDs are configured identities, not display names to normalize.
	const userPeerId = params.config.peerName;
	const aiPeerId = params.config.aiPeer;

	const [userPeer, aiPeer, session] = await Promise.all([
		honcho.peer(userPeerId, { configuration: { observeMe: true } }) as Promise<unknown>,
		honcho.peer(aiPeerId, { configuration: { observeMe: true } }) as Promise<unknown>,
		honcho.session(params.sessionKey) as Promise<unknown>,
	]);

	const peerConfigs: Record<string, { observeMe: boolean; observeOthers: boolean }> = {
		[userPeerId]: { observeMe: true, observeOthers: false },
		[aiPeerId]: { observeMe: true, observeOthers: params.config.observationMode === "directional" },
	};

	const honchoSession = session as HonchoSession;
	await honchoSession.addPeers(Object.entries(peerConfigs) as [string, { observeMe: boolean; observeOthers: boolean }][]);

	return {
		honcho,
		workspaceId: params.config.workspace,
		sessionId: params.sessionKey,
		userPeerId,
		aiPeerId,
		userPeerName: params.config.peerName,
		aiPeerName: params.config.aiPeer,
		userPeer: userPeer as HonchoPeer,
		aiPeer: aiPeer as HonchoPeer,
		session: honchoSession,
		config: params.config,
	};
}
