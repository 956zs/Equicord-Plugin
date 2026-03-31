import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { IconComponent, OptionType } from "@utils/types";

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Enable vertical formatting for outgoing messages.",
    },
    rows: {
        type: OptionType.NUMBER,
        default: 30,
        description: "Number of characters to place in each vertical column.",
    },
    applyOnEdit: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Also format edited messages before they are saved.",
    },
    preserveParagraphs: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Keep paragraphs separate instead of merging all lines into one block.",
    },
    paragraphGap: {
        type: OptionType.NUMBER,
        default: 1,
        description: "Number of blank lines to insert between formatted paragraphs.",
    },
});

const CELL_SEPARATOR = "　";
const FILLER = "　";
const CHAR_REPLACEMENTS: Record<string, string> = {
    // Add your own punctuation mappings here if needed.
    // Example:
    // "，": "︐",
    // "。": "︒",
};

const PROTECTED_DISCORD_SYNTAX_PATTERNS = [
    /<a?:\w{2,32}:\d{17,20}>/,
    /<@!?\d{17,20}>/,
    /<@&\d{17,20}>/,
    /<#\d{17,20}>/,
    /<\/[^:\n>]+:\d{17,20}>/,
    /<t:\d+(?::[tTdDfFR])?>/,
];

function isHalfWidthAscii(char: string) {
    const code = char.codePointAt(0);
    if (code == null) return false;

    return code >= 0x21 && code <= 0x7e;
}

function insertSpaceBeforeHalfWidthAscii(input: string) {
    let result = "";

    for (const char of input) {
        if (isHalfWidthAscii(char)) {
            result += " ";
        }

        result += char;
    }

    return result;
}

function normalizeInput(input: string) {
    return Array.from(input, char => CHAR_REPLACEMENTS[char] ?? char)
        .join("")
        .replace(/[\s\u3000]+/g, "");
}

function toVerticalLayout(input: string, rows: number) {
    const normalized = normalizeInput(input);
    const characters = Array.from(normalized);

    if (!characters.length) return normalized;

    const safeRows = Math.max(1, Math.floor(rows));
    const columns: string[][] = [];

    for (let index = 0; index < characters.length; index += safeRows) {
        columns.push(characters.slice(index, index + safeRows));
    }

    const lines: string[] = [];

    for (let row = 0; row < safeRows; row++) {
        lines.push(
            columns
                .slice()
                .reverse()
                .map(column => column[row] ?? FILLER)
                .join(CELL_SEPARATOR)
        );
    }

    return lines.join("\n");
}

function getParagraphs(content: string) {
    const normalized = content.replace(/\r\n?/g, "\n");

    if (!settings.store.preserveParagraphs) {
        const merged = normalized
            .split("\n")
            .map(part => part.trim())
            .filter(Boolean)
            .join("");

        return merged ? [merged] : [];
    }

    return normalized
        .split(/\n\s*\n+/)
        .map(paragraph => paragraph
            .split("\n")
            .map(line => line.trim())
            .filter(Boolean)
            .join(""))
        .filter(Boolean);
}

function shouldBypassFormatting(content: string) {
    return PROTECTED_DISCORD_SYNTAX_PATTERNS.some(pattern => pattern.test(content));
}

function transformContent(content: string) {
    if (shouldBypassFormatting(content)) return content;

    const paragraphs = getParagraphs(content);

    if (!paragraphs.length) return content;

    const gap = "\n".repeat(Math.max(1, Math.floor(settings.store.paragraphGap)) + 1);
    return paragraphs
        .map(paragraph => insertSpaceBeforeHalfWidthAscii(toVerticalLayout(paragraph, settings.store.rows)))
        .join(gap);
}

const CandyCaneIcon: IconComponent & { disabled?: boolean; } = ({ height = 20, width = 20, className, disabled }) => {
    const stroke = disabled ? "var(--interactive-muted)" : "currentColor";

    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={width}
            height={height}
            viewBox="0 0 24 24"
            fill="none"
            stroke={stroke}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
        >
            <path d="M5.7 21a2 2 0 0 1-3.5-2l8.6-14a6 6 0 0 1 10.4 6 2 2 0 1 1-3.464-2 2 2 0 1 0-3.464-2Z" />
            <path d="M17.75 7 15 2.1" />
            <path d="M10.9 4.8 13 9" />
            <path d="m7.9 9.7 2 4.4" />
            <path d="M4.9 14.7 7 18.9" />
            {disabled && <path stroke="var(--status-danger)" d="M4 20 20 4" />}
        </svg>
    );
};

const VerticalWriterToggle: ChatBarButtonFactory = ({ isMainChat }) => {
    const { enabled } = settings.use(["enabled"]);

    if (!isMainChat) return null;

    return (
        <ChatBarButton
            tooltip={enabled ? "Disable Vertical Writer" : "Enable Vertical Writer"}
            onClick={() => settings.store.enabled = !enabled}
        >
            <CandyCaneIcon disabled={!enabled} />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "CustomVerticalWriter",
    description: "Formats outgoing messages into a right-to-left vertical layout when toggled on.",
    authors: [{ name: "nlcat", id: 586502118530351114n }],
    settings,
    chatBarButton: {
        icon: CandyCaneIcon,
        render: VerticalWriterToggle
    },

    onBeforeMessageSend(_, msg) {
        if (!settings.store.enabled || !msg.content) return;
        msg.content = transformContent(msg.content);
    },

    onBeforeMessageEdit(_, __, msg) {
        if (!settings.store.enabled || !settings.store.applyOnEdit || !msg.content) return;
        msg.content = transformContent(msg.content);
    },
});
