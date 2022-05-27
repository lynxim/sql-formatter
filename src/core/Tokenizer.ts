import * as regexFactory from './regexFactory';
import { equalizeWhitespace, escapeRegExp, id } from '../utils';
import { Token, TokenType } from './token'; // convert to partial type import in TS 4.5

export const WHITESPACE_REGEX = /^(\s+)/u;
const NULL_REGEX = /(?!)/; // zero-width negative lookahead, matches nothing

const toCanonicalKeyword = (text: string) => equalizeWhitespace(text.toUpperCase());

/** Struct that defines how a SQL language can be broken into tokens */
interface TokenizerOptions {
  reservedKeywords: string[];
  reservedCommands: string[];
  reservedLogicalOperators?: string[];
  reservedDependentClauses: string[];
  reservedBinaryCommands: string[];
  reservedJoinConditions?: string[];
  stringTypes: regexFactory.QuoteType[];
  identifierTypes: regexFactory.QuoteType[];
  blockStart?: string[];
  blockEnd?: string[];
  positionalPlaceholders?: boolean;
  numberedPlaceholderTypes?: ('?' | ':' | '$')[];
  namedPlaceholderTypes?: (':' | '@' | '$')[];
  quotedPlaceholderTypes?: (':' | '@' | '$')[];
  lineCommentTypes?: string[];
  specialIdentChars?: { prefix?: string; any?: string; suffix?: string };
  operators?: string[];
  preprocess?: (tokens: Token[]) => Token[];
}

type PlaceholderPattern = { regex: RegExp; parseKey: (s: string) => string };

/** Converts SQL language string into a token stream */
export default class Tokenizer {
  private REGEX_MAP: Record<TokenType, RegExp>;
  private quotedIdentRegex: RegExp;
  private placeholderPatterns: PlaceholderPattern[];

  private preprocess = (tokens: Token[]) => tokens;

  /**
   * @param {TokenizerOptions} cfg
   *  @param {string[]} cfg.reservedKeywords - Reserved words in SQL
   *  @param {string[]} cfg.reservedDependentClauses - Words that following a specific Statement and must have data attached
   *  @param {string[]} cfg.reservedLogicalOperators - Words that are set to newline
   *  @param {string[]} cfg.reservedCommands - Words that are set to new line separately
   *  @param {string[]} cfg.reservedBinaryCommands - Words that are top level but have no indentation
   *  @param {string[]} cfg.reservedJoinConditions - ON and USING
   *  @param {string[]} cfg.stringTypes - string types to enable - '', "", N'', ...
   *  @param {string[]} cfg.identifierTypes - identifier types to enable - "", ``, [], ...
   *  @param {string[]} cfg.blockStart - Opening parentheses to enable, like (, [
   *  @param {string[]} cfg.blockEnd - Closing parentheses to enable, like ), ]
   *  @param {boolean} cfg.positionalPlaceholders - True to enable positional placeholders "?"
   *  @param {string[]} cfg.numberedPlaceholderTypes - Prefixes for numbered placeholders, like ":" for :1, :2, :3
   *  @param {string[]} cfg.namedPlaceholderTypes - Prefixes for named placeholders, like @ and :
   *  @param {string[]} cfg.lineCommentTypes - Line comments to enable, like # and --
   *  @param {string[]} cfg.specialIdentChars - Special chars that can be found inside identifiers, like @ and #
   *  @param {string[]} cfg.operators - Additional operators to recognize
   *  @param {Function} cfg.preprocess - Optional function to process tokens before emitting
   */
  constructor(cfg: TokenizerOptions) {
    if (cfg.preprocess) {
      this.preprocess = cfg.preprocess;
    }

    const specialIdentCharsAll = Object.values(cfg.specialIdentChars ?? {}).join('');
    this.quotedIdentRegex = regexFactory.createQuoteRegex(cfg.identifierTypes);

    this.REGEX_MAP = {
      [TokenType.IDENT]: regexFactory.createIdentRegex(cfg.specialIdentChars),
      [TokenType.STRING]: regexFactory.createQuoteRegex(cfg.stringTypes),
      [TokenType.RESERVED_KEYWORD]: regexFactory.createReservedWordRegex(
        cfg.reservedKeywords,
        specialIdentCharsAll
      ),
      [TokenType.RESERVED_DEPENDENT_CLAUSE]: regexFactory.createReservedWordRegex(
        cfg.reservedDependentClauses ?? [],
        specialIdentCharsAll
      ),
      [TokenType.RESERVED_LOGICAL_OPERATOR]: regexFactory.createReservedWordRegex(
        cfg.reservedLogicalOperators ?? ['AND', 'OR'],
        specialIdentCharsAll
      ),
      [TokenType.RESERVED_COMMAND]: regexFactory.createReservedWordRegex(
        cfg.reservedCommands,
        specialIdentCharsAll
      ),
      [TokenType.RESERVED_BINARY_COMMAND]: regexFactory.createReservedWordRegex(
        cfg.reservedBinaryCommands,
        specialIdentCharsAll
      ),
      [TokenType.RESERVED_JOIN_CONDITION]: regexFactory.createReservedWordRegex(
        cfg.reservedJoinConditions ?? ['ON', 'USING'],
        specialIdentCharsAll
      ),
      [TokenType.OPERATOR]: regexFactory.createOperatorRegex('+-/*%&|^><=.,;[]{}`:$@', [
        '<>',
        '<=',
        '>=',
        '!=',
        ...(cfg.operators ?? []),
      ]),
      [TokenType.BLOCK_START]: regexFactory.createParenRegex(cfg.blockStart ?? ['(']),
      [TokenType.BLOCK_END]: regexFactory.createParenRegex(cfg.blockEnd ?? [')']),
      [TokenType.RESERVED_CASE_START]: /^(CASE)\b/iu,
      [TokenType.RESERVED_CASE_END]: /^(END)\b/iu,
      [TokenType.LINE_COMMENT]: regexFactory.createLineCommentRegex(cfg.lineCommentTypes ?? ['--']),
      [TokenType.BLOCK_COMMENT]: /^(\/\*[^]*?(?:\*\/|$))/u,
      [TokenType.NUMBER]:
        /^(0x[0-9a-fA-F]+|0b[01]+|(-\s*)?[0-9]+(\.[0-9]*)?([eE][-+]?[0-9]+(\.[0-9]+)?)?)/u,
      [TokenType.PLACEHOLDER]: NULL_REGEX, // matches nothing
      [TokenType.EOF]: NULL_REGEX, // matches nothing
    };

    this.placeholderPatterns = this.excludePatternsWithoutRegexes([
      {
        // :name placeholders
        regex: regexFactory.createPlaceholderRegex(
          cfg.namedPlaceholderTypes ?? [],
          '[a-zA-Z0-9_$]+'
        ),
        parseKey: v => v.slice(1),
      },
      {
        // :"name" placeholders
        regex: regexFactory.createPlaceholderRegex(
          cfg.quotedPlaceholderTypes ?? [],
          regexFactory.createQuotePattern(cfg.identifierTypes)
        ),
        parseKey: v =>
          this.getEscapedPlaceholderKey({ key: v.slice(2, -1), quoteChar: v.slice(-1) }),
      },
      {
        // :1, :2, :3 placeholders
        regex: regexFactory.createPlaceholderRegex(cfg.numberedPlaceholderTypes ?? [], '[0-9]+'),
        parseKey: v => v.slice(1),
      },
      {
        // ? placeholders
        regex: cfg.positionalPlaceholders ? /^(\?)/ : undefined,
        parseKey: v => v.slice(1),
      },
    ]);
  }

  private excludePatternsWithoutRegexes(
    patterns: { regex?: RegExp; parseKey: (s: string) => string }[]
  ) {
    return patterns.filter((p): p is PlaceholderPattern => p.regex !== undefined);
  }

  /**
   * Takes a SQL string and breaks it into tokens.
   * Each token is an object with type and value.
   *
   * @param {string} input - The SQL string
   * @returns {Token[]} output token stream
   */
  public tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let token: Token | undefined;

    // Keep processing the string until it is empty
    while (input.length) {
      // grab any preceding whitespace
      const whitespaceBefore = this.getWhitespace(input);
      input = input.substring(whitespaceBefore.length);

      if (input.length) {
        // Get the next token and the token type
        token = this.getNextToken(input, token);
        if (!token) {
          throw new Error(`Parse error: Unexpected "${input.slice(0, 100)}"`);
        }
        // Advance the string
        input = input.substring(token.text.length);

        tokens.push({ ...token, whitespaceBefore });
      }
    }
    return this.preprocess(tokens);
  }

  /** Matches preceding whitespace if present */
  private getWhitespace(input: string): string {
    const matches = input.match(WHITESPACE_REGEX);
    return matches ? matches[1] : '';
  }

  /** Attempts to match next token from input string, tests RegExp patterns in decreasing priority */
  private getNextToken(input: string, previousToken?: Token): Token | undefined {
    return (
      this.matchToken(TokenType.LINE_COMMENT, input) ||
      this.matchToken(TokenType.BLOCK_COMMENT, input) ||
      this.matchToken(TokenType.STRING, input) ||
      this.matchQuotedIdentToken(input) ||
      this.matchToken(TokenType.BLOCK_START, input) ||
      this.matchToken(TokenType.BLOCK_END, input) ||
      this.matchPlaceholderToken(input) ||
      this.matchToken(TokenType.NUMBER, input) ||
      this.matchReservedWordToken(input, previousToken) ||
      this.matchToken(TokenType.IDENT, input) ||
      this.matchToken(TokenType.OPERATOR, input)
    );
  }

  /**
   * Attempts to match a placeholder token pattern
   * @return {Token | undefined} - The placeholder token if found, otherwise undefined
   */
  private matchPlaceholderToken(input: string): Token | undefined {
    for (const { regex, parseKey } of this.placeholderPatterns) {
      const token = this.match({
        input,
        regex,
        type: TokenType.PLACEHOLDER,
        transform: id,
      });
      if (token) {
        return { ...token, key: parseKey(token.value) };
      }
    }
    return undefined;
  }

  private getEscapedPlaceholderKey({ key, quoteChar }: { key: string; quoteChar: string }): string {
    return key.replace(new RegExp(escapeRegExp('\\' + quoteChar), 'gu'), quoteChar);
  }

  private matchQuotedIdentToken(input: string): Token | undefined {
    return this.match({
      input,
      regex: this.quotedIdentRegex,
      type: TokenType.IDENT,
      transform: id,
    });
  }

  /**
   * Attempts to match a Reserved word token pattern, avoiding edge cases of Reserved words within string tokens
   * @return {Token | undefined} - The Reserved word token if found, otherwise undefined
   */
  private matchReservedWordToken(input: string, previousToken?: Token): Token | undefined {
    // A reserved word cannot be preceded by a '.'
    // this makes it so in "mytable.from", "from" is not considered a reserved word
    if (previousToken?.value === '.') {
      return undefined;
    }

    // prioritised list of Reserved token types
    return (
      this.matchReservedToken(TokenType.RESERVED_CASE_START, input) ||
      this.matchReservedToken(TokenType.RESERVED_CASE_END, input) ||
      this.matchReservedToken(TokenType.RESERVED_COMMAND, input) ||
      this.matchReservedToken(TokenType.RESERVED_BINARY_COMMAND, input) ||
      this.matchReservedToken(TokenType.RESERVED_DEPENDENT_CLAUSE, input) ||
      this.matchReservedToken(TokenType.RESERVED_LOGICAL_OPERATOR, input) ||
      this.matchReservedToken(TokenType.RESERVED_KEYWORD, input) ||
      this.matchReservedToken(TokenType.RESERVED_JOIN_CONDITION, input)
    );
  }

  // Helper for matching RESERVED_* tokens which need to be transformed to canonical form
  private matchReservedToken(tokenType: TokenType, input: string): Token | undefined {
    return this.match({
      input,
      type: tokenType,
      regex: this.REGEX_MAP[tokenType],
      transform: toCanonicalKeyword,
    });
  }

  // Shorthand for `match` that looks up regex from REGEX_MAP
  private matchToken(tokenType: TokenType, input: string): Token | undefined {
    return this.match({
      input,
      type: tokenType,
      regex: this.REGEX_MAP[tokenType],
      transform: id,
    });
  }

  /**
   * Attempts to match RegExp from head of input, returning undefined if not found
   * @param {string} _.input - The string to match
   * @param {TokenType} _.type - The type of token to match against
   * @param {RegExp} _.regex - The regex to match
   * @return {Token | undefined} - The matched token if found, otherwise undefined
   */
  private match({
    input,
    type,
    regex,
    transform,
  }: {
    input: string;
    type: TokenType;
    regex: RegExp;
    transform: (s: string) => string;
  }): Token | undefined {
    const matches = input.match(regex);
    if (matches) {
      return {
        type,
        text: matches[1],
        value: transform(matches[1]),
      };
    }
    return undefined;
  }
}
