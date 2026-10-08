import { Button } from '../ui/Button'
import {
  commandLine,
  questionIntro,
  sourceLabel,
  type McpjsonAnswer,
  type McpjsonAnswers,
  type McpjsonServer,
} from '../lib/mcpjson'

/**
 * The New session dialog's `.mcp.json` question, swapped into its shell
 * (spec 2026-10-08-mcpjson-approval-design § Clients; canvas `Feature - MCP
 * approval` 47a/47b, the project-file row from 2d). The dialog owns the
 * header, the footer and the launch; these are the intro and the rows.
 */

/** 47a/47b: the line under the header, naming `.mcp.json` in mono. */
export function McpjsonIntro({ count }: { count: number }) {
  return (
    <p className="text-[13px] leading-[1.55] text-pretty text-[rgba(200,214,235,.88)]">
      Its <span className="font-mono text-[12px] text-[#dfeeff]">.mcp.json</span>
      {questionIntro(count, 'this Mac')}
    </p>
  )
}

export interface McpjsonRowsProps {
  servers: readonly McpjsonServer[]
  answers: McpjsonAnswers
  onAnswer: (name: string, answer: McpjsonAnswer) => void
  /** *View file* on a project-file row. */
  onViewFile: (server: McpjsonServer & { file: string }) => void
}

export function McpjsonRows({ servers, answers, onAnswer, onViewFile }: McpjsonRowsProps) {
  return (
    <div>
      {servers.map((server, i) => (
        <McpjsonRow
          key={server.name}
          server={server}
          first={i === 0}
          answer={answers[server.name]}
          onAnswer={(answer) => onAnswer(server.name, answer)}
          onViewFile={onViewFile}
        />
      ))}
    </div>
  )
}

function McpjsonRow({
  server,
  first,
  answer,
  onAnswer,
  onViewFile,
}: {
  server: McpjsonServer
  first: boolean
  answer: McpjsonAnswer | undefined
  onAnswer: (answer: McpjsonAnswer) => void
  onViewFile: McpjsonRowsProps['onViewFile']
}) {
  const file = server.source === 'file' && server.file ? server.file : null
  return (
    // 47b: the command column and a 216px choice column, 20px apart; 14px
    // rows, a hairline between them and none over the first.
    <div
      className={[
        'grid grid-cols-[minmax(0,1fr)_216px] items-start gap-x-5 border-t py-3.5',
        first ? 'border-transparent' : 'border-[rgba(150,205,255,.08)]',
      ].join(' ')}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[13px] font-semibold text-text-bright">{server.name}</span>
          {file ? (
            // 2d: the amber of the auto permission mode ("runs unchecked"), a
            // dot and the label only — oklch(76% .16 85) dot, oklch(84% .12 85) ink.
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] text-[oklch(84%_.12_85)]">
              <span aria-hidden className="block h-1.5 w-1.5 rounded-full bg-[oklch(76%_.16_85)]" />
              {sourceLabel('file')}
            </span>
          ) : (
            <span className="font-mono text-[10px] tracking-[0.12em] text-[rgba(160,190,225,.5)]">
              {sourceLabel(server.source)}
            </span>
          )}
        </div>
        {/* What runs is the point: wrapped, never truncated (47e "Server row"). */}
        <div
          className={[
            'rounded-lg border bg-[rgba(4,8,16,.6)] px-3 py-[9px] font-mono text-[12px] leading-[1.6] whitespace-pre-wrap text-[#dfeeff] [overflow-wrap:anywhere]',
            file ? 'border-[oklch(76%_.16_85/.3)]' : 'border-[rgba(150,205,255,.12)]',
          ].join(' ')}
        >
          {commandLine(server)}
        </div>
        {file && (
          <div className="flex items-baseline gap-2.5 text-[12px] leading-[1.5] text-pretty text-[rgba(160,190,225,.7)]">
            <span className="min-w-0 flex-1">Runs a file from this project — the command alone doesn&apos;t say what it does.</span>
            <Button variant="pill-quiet" size="strip" className="shrink-0" onClick={() => onViewFile({ ...server, file })}>
              View file
            </Button>
          </div>
        )}
      </div>
      {/* No default, no hue for yes or no (47e CHOICE). 24px down, level with the well. */}
      <div role="radiogroup" aria-label={server.name} className="grid grid-cols-2 gap-1.5 pt-6">
        <Button
          role="radio"
          aria-checked={answer === 'allow'}
          variant={answer === 'allow' ? 'choice-on' : 'choice'}
          size="choice"
          onClick={() => onAnswer('allow')}
        >
          Allow
        </Button>
        <Button
          role="radio"
          aria-checked={answer === 'deny'}
          variant={answer === 'deny' ? 'choice-on' : 'choice'}
          size="choice"
          onClick={() => onAnswer('deny')}
        >
          Don&apos;t allow
        </Button>
      </div>
    </div>
  )
}
