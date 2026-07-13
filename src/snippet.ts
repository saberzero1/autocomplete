import {Decoration, DecorationSet, WidgetType, EditorView, keymap, KeyBinding} from "@codemirror/view"
import {StateField, StateEffect, ChangeDesc, EditorState, EditorSelection,
        Transaction, TransactionSpec, Text, StateCommand, Prec, Facet, MapMode} from "@codemirror/state"
import {indentUnit} from "@codemirror/language"
import {baseTheme} from "./theme"
import {Completion, pickedCompletion} from "./completion"

class FieldPos {
  constructor(public field: number,
              readonly line: number,
              public from: number,
              public to: number) {}
}

class FieldRange {
  constructor(readonly field: number, readonly from: number, readonly to: number) {}

  map(changes: ChangeDesc) {
    let from = changes.mapPos(this.from, -1, MapMode.TrackDel)
    let to = changes.mapPos(this.to, 1, MapMode.TrackDel)
    return from == null || to == null ? null : new FieldRange(this.field, from, to)
  }
}

interface SnippetChoices {
  [fieldIndex: number]: string[]
}

class Snippet {
  constructor(readonly lines: readonly string[],
              readonly fieldPositions: readonly FieldPos[],
              readonly choices: SnippetChoices = {}) {}

  instantiate(state: EditorState, pos: number) {
    let text = [], lineStart = [pos]
    let lineObj = state.doc.lineAt(pos), baseIndent = /^\s*/.exec(lineObj.text)![0]
    for (let line of this.lines) {
      if (text.length) {
        let indent = baseIndent, tabs = /^\t*/.exec(line)![0].length
        for (let i = 0; i < tabs; i++) indent += state.facet(indentUnit)
        lineStart.push(pos + indent.length - tabs)
        line = indent + line.slice(tabs)
      }
      text.push(line)
      pos += line.length + 1
    }
    let ranges = this.fieldPositions.map(
      pos => new FieldRange(pos.field, lineStart[pos.line] + pos.from, lineStart[pos.line] + pos.to))
    return {text, ranges, choices: this.choices}
  }

  static parse(template: string) {
    let fields: {seq: number | null, name: string}[] = []
    let lines = [], positions: FieldPos[] = []
    let choices: SnippetChoices = {}

    function shiftChoices(from: number) {
      let updated: SnippetChoices = {}
      for (let key in choices) {
        let index = +key
        updated[index >= from ? index + 1 : index] = choices[index]
      }
      choices = updated
    }

    function fieldIndex(seq: number | null, name: string) {
      if (seq === 0) seq = 1e9
      let found = -1
      for (let i = 0; i < fields.length; i++) {
        if (seq != null ? fields[i].seq == seq : name ? fields[i].name == name : false) found = i
      }
      if (found < 0) {
        let i = 0
        while (i < fields.length && (seq == null || (fields[i].seq != null && fields[i].seq! < seq))) i++
        fields.splice(i, 0, {seq, name})
        found = i
        for (let pos of positions) if (pos.field >= found) pos.field++
        if (Object.keys(choices).length) shiftChoices(found)
      }
      return found
    }

    function isDigit(ch: string) { return ch >= "0" && ch <= "9" }

    class LineParser {
      pos = 0
      out = ""

      constructor(readonly input: string, readonly line: number) {}

      parse() {
        this.parseText(false)
        return this.out
      }

      parseText(stopOnBrace: boolean) {
        while (this.pos < this.input.length) {
          let ch = this.input.charAt(this.pos)
          if (stopOnBrace && ch == "}") {
            this.pos++
            return
          }
          if (ch == "\\") {
            if (this.takeEscape()) continue
          }
          if (ch == "$" || ch == "#") {
            let next = this.input.charAt(this.pos + 1)
            if (ch == "$" && next == "$") {
              this.out += "$"
              this.pos += 2
              continue
            }
            if (next == "{") {
              this.pos += 2
              this.parseField()
              continue
            }
            if (ch == "$" && isDigit(next)) {
              this.pos++
              this.parseBareTabstop()
              continue
            }
          }
          this.out += ch
          this.pos++
        }
      }

      takeEscape() {
        let next = this.input.charAt(this.pos + 1)
        if (next && (next == "{" || next == "}" || next == "$" || next == "\\" || next == "|")) {
          this.out += next
          this.pos += 2
          return true
        }
        return false
      }

      parseBareTabstop() {
        let seq = 0
        while (this.pos < this.input.length) {
          let ch = this.input.charAt(this.pos)
          if (!isDigit(ch)) break
          seq = seq * 10 + ch.charCodeAt(0) - 48
          this.pos++
        }
        let field = fieldIndex(seq, "")
        positions.push(new FieldPos(field, this.line, this.out.length, this.out.length))
      }

      parseField() {
        if (this.pos >= this.input.length) {
          this.out += "${"
          return
        }
        let ch = this.input.charAt(this.pos)
        if (isDigit(ch)) {
          let start = this.pos
          let seq = 0
          while (this.pos < this.input.length) {
            ch = this.input.charAt(this.pos)
            if (!isDigit(ch)) break
            seq = seq * 10 + ch.charCodeAt(0) - 48
            this.pos++
          }
          let next = this.input.charAt(this.pos)
          if (next == ":" || next == "|" || next == "/" || next == "}") {
            let field = fieldIndex(seq, "")
            if (next == ":") {
              this.pos++
              let pos = new FieldPos(field, this.line, this.out.length, this.out.length)
              positions.push(pos)
              this.parseText(true)
              pos.to = this.out.length
              return
            }
            if (next == "|") {
              this.pos++
              let pos = new FieldPos(field, this.line, this.out.length, this.out.length)
              positions.push(pos)
              let options = this.parseChoices()
              let first = options.length ? options[0] : ""
              this.out += first
              pos.to = this.out.length
              if (!choices[field]) choices[field] = options
              return
            }
            if (next == "/") {
              this.pos++
              positions.push(new FieldPos(field, this.line, this.out.length, this.out.length))
              this.skipTransform()
              return
            }
            this.pos++
            positions.push(new FieldPos(field, this.line, this.out.length, this.out.length))
            return
          }
          this.pos = start
        }
        let name = this.parseName()
        let field = fieldIndex(null, name)
        let from = this.out.length
        this.out += name
        positions.push(new FieldPos(field, this.line, from, this.out.length))
      }

      parseName() {
        let name = ""
        while (this.pos < this.input.length) {
          let ch = this.input.charAt(this.pos)
          if (ch == "}") {
            this.pos++
            return name
          }
          if (ch == "\\" && (this.input.charAt(this.pos + 1) == "{" || this.input.charAt(this.pos + 1) == "}")) {
            name += this.input.charAt(this.pos + 1)
            this.pos += 2
            continue
          }
          name += ch
          this.pos++
        }
        return name
      }

      parseChoices() {
        let options: string[] = []
        let current = ""
        while (this.pos < this.input.length) {
          let ch = this.input.charAt(this.pos)
          if (ch == "\\") {
            let next = this.input.charAt(this.pos + 1)
            if (next && (next == "," || next == "|" || next == "}" || next == "\\")) {
              current += next
              this.pos += 2
              continue
            }
          }
          if (ch == ",") {
            options.push(current)
            current = ""
            this.pos++
            continue
          }
          if (ch == "|" && this.input.charAt(this.pos + 1) == "}") {
            options.push(current)
            this.pos += 2
            return options
          }
          current += ch
          this.pos++
        }
        options.push(current)
        return options
      }

      skipTransform() {
        if (!this.skipTo("/")) return
        if (!this.skipTo("/")) return
        this.skipTo("}")
      }

      skipTo(end: string) {
        while (this.pos < this.input.length) {
          let ch = this.input.charAt(this.pos)
          if (ch == "\\") {
            if (this.pos + 1 < this.input.length) {
              this.pos += 2
              continue
            }
            this.pos++
            continue
          }
          if (ch == end) {
            this.pos++
            return true
          }
          this.pos++
        }
        return false
      }
    }

    for (let line of template.split(/\r\n?|\n/)) {
      let parser: LineParser = new LineParser(line, lines.length)
      lines.push(parser.parse())
    }
    return new Snippet(lines, positions, choices)
  }
}

let fieldMarker = Decoration.widget({widget: new class extends WidgetType {
  toDOM() {
    let span = document.createElement("span")
    span.className = "cm-snippetFieldPosition"
    return span
  }
  ignoreEvent() { return false }
}})
let fieldRange = Decoration.mark({class: "cm-snippetField"})
let activeSnippetChoices: SnippetChoices = {}

class ActiveSnippet {
  deco: DecorationSet

  constructor(readonly ranges: readonly FieldRange[],
              readonly active: number,
              readonly choices: SnippetChoices = activeSnippetChoices) {
    activeSnippetChoices = this.choices
    this.deco = Decoration.set(ranges.map(r => (r.from == r.to ? fieldMarker : fieldRange).range(r.from, r.to)), true)
  }

  map(changes: ChangeDesc) {
    let ranges = []
    for (let r of this.ranges) {
      let mapped = r.map(changes)
      if (!mapped) return null
      ranges.push(mapped)
    }
    return new ActiveSnippet(ranges, this.active)
  }

  selectionInsideField(sel: EditorSelection) {
    return sel.ranges.every(
      range => this.ranges.some(r => r.field == this.active && r.from <= range.from && r.to >= range.to))
  }
}

const setActive = StateEffect.define<ActiveSnippet | null>({
  map(value, changes) { return value && value.map(changes) }
})

const moveToField = StateEffect.define<number>()

export const snippetState = StateField.define<ActiveSnippet | null>({
  create() { return null },

  update(value, tr) {
    for (let effect of tr.effects) {
      if (effect.is(setActive)) return effect.value
      if (effect.is(moveToField) && value) return new ActiveSnippet(value.ranges, effect.value)
    }
    if (value && tr.docChanged) value = value.map(tr.changes)
    if (value && tr.selection && !value.selectionInsideField(tr.selection)) value = null
    return value
  },

  provide: f => EditorView.decorations.from(f, val => val ? val.deco : Decoration.none)
})

function fieldSelection(ranges: readonly FieldRange[], field: number) {
  return EditorSelection.create(ranges.filter(r => r.field == field).map(r => EditorSelection.range(r.from, r.to)))
}

/// Convert a snippet template to a function that can
/// [apply](#autocomplete.Completion.apply) it. Snippets are written
/// using syntax like this:
///
///     "for (let ${index} = 0; ${index} < ${end}; ${index}++) {\n\t${}\n}"
///
/// Each `${}` placeholder (you may also use `#{}`) indicates a field
/// that the user can fill in. Its name, if any, will be the default
/// content for the field.
///
/// When the snippet is activated by calling the returned function,
/// the code is inserted at the given position. Newlines in the
/// template are indented by the indentation of the start line, plus
/// one [indent unit](#language.indentUnit) per tab character after
/// the newline.
///
/// On activation, (all instances of) the first field are selected.
/// The user can move between fields with Tab and Shift-Tab as long as
/// the fields are active. Moving to the last field or moving the
/// cursor out of the current field deactivates the fields.
///
/// The order of fields defaults to textual order, but you can add
/// numbers to placeholders (`${1}` or `${1:defaultText}`) to provide
/// a custom order. `${0}` is special—it is always the last stop, where
/// the cursor ends up after tabbing through the other fields.
///
/// To include a literal `{` or `}` in your template, put a backslash
/// in front of it. This will be removed and the brace will not be
/// interpreted as indicating a placeholder.
export function snippet(template: string) {
  let snippet = Snippet.parse(template)
  return (editor: {state: EditorState, dispatch: (tr: Transaction) => void}, completion: Completion | null, from: number, to: number) => {
    let {text, ranges, choices} = snippet.instantiate(editor.state, from)
    let {main} = editor.state.selection
    let spec: TransactionSpec = {
      changes: {from, to: to == main.from ? main.to : to, insert: Text.of(text)},
      scrollIntoView: true,
      annotations: completion ? [pickedCompletion.of(completion), Transaction.userEvent.of("input.complete")] : undefined
    }
    if (ranges.length) spec.selection = fieldSelection(ranges, 0)
    if (ranges.some(r => r.field > 0)) {
      let active = new ActiveSnippet(ranges, 0, choices)
      let effects: StateEffect<unknown>[] = spec.effects = [setActive.of(active)]
      if (editor.state.field(snippetState, false) === undefined)
        effects.push(StateEffect.appendConfig.of([snippetState, addSnippetKeymap, snippetPointerHandler, baseTheme]))
    }
    editor.dispatch(editor.state.update(spec))
  }
}

function moveField(dir: 1 | -1): StateCommand {
  return ({state, dispatch}) => {
    let active = state.field(snippetState, false)
    if (!active || dir < 0 && active.active == 0) return false
    let next = active.active + dir, last = dir > 0 && !active.ranges.some(r => r.field == next + dir)
    dispatch(state.update({
      selection: fieldSelection(active.ranges, next),
      effects: setActive.of(last ? null : new ActiveSnippet(active.ranges, next)),
      scrollIntoView: true
    }))
    return true
  }
}

/// A command that clears the active snippet, if any.
export const clearSnippet: StateCommand = ({state, dispatch}) => {
  let active = state.field(snippetState, false)
  if (!active) return false
  dispatch(state.update({effects: setActive.of(null)}))
  return true
}

/// Move to the next snippet field, if available.
export const nextSnippetField = moveField(1)

/// Move to the previous snippet field, if available.
export const prevSnippetField = moveField(-1)

/// Check if there is an active snippet with a next field for
/// `nextSnippetField` to move to.
export function hasNextSnippetField(state: EditorState) {
  let active = state.field(snippetState, false)
  return !!(active && active.ranges.some(r => r.field == active!.active + 1))
}

/// Returns true if there is an active snippet and a previous field
/// for `prevSnippetField` to move to.
export function hasPrevSnippetField(state: EditorState) {
  let active = state.field(snippetState, false)
  return !!(active && active.active > 0)
}

/// Cycle through choice options for the active snippet field.
/// `dir` is 1 for next choice, -1 for previous.
/// Returns false if there is no active snippet or no choices for the
/// current field.
export function cycleSnippetChoice(dir: 1 | -1): StateCommand {
  return ({state, dispatch}) => {
    let active = state.field(snippetState, false)
    if (!active) return false
    let choices = active.choices[active.active]
    if (!choices || choices.length === 0) return false
    let activeRanges = active.ranges.filter(r => r.field == active!.active)
    if (activeRanges.length === 0) return false
    let currentText = state.sliceDoc(activeRanges[0].from, activeRanges[0].to)
    let idx = choices.indexOf(currentText)
    let next = idx < 0 ? 0 : (idx + dir + choices.length) % choices.length
    let changes = activeRanges.map(r => ({from: r.from, to: r.to, insert: choices![next]}))
    let newRanges = []
    let offset = 0
    for (let i = 0; i < active.ranges.length; i++) {
      let r = active.ranges[i]
      let changeIdx = activeRanges.indexOf(r)
      if (changeIdx >= 0) {
        let newFrom = r.from + offset
        let newTo = newFrom + choices![next].length
        newRanges.push(new FieldRange(r.field, newFrom, newTo))
        offset += choices![next].length - (r.to - r.from)
      } else {
        newRanges.push(new FieldRange(r.field, r.from + offset, r.to + offset))
      }
    }
    dispatch(state.update({
      changes,
      selection: fieldSelection(newRanges, active.active),
      effects: setActive.of(new ActiveSnippet(newRanges, active.active)),
      scrollIntoView: true
    }))
    return true
  }
}

const defaultSnippetKeymap = [
  {key: "Tab", run: nextSnippetField, shift: prevSnippetField},
  {key: "Escape", run: clearSnippet}
]

/// A facet that can be used to configure the key bindings used by
/// snippets. The default binds Tab to
/// [`nextSnippetField`](#autocomplete.nextSnippetField), Shift-Tab to
/// [`prevSnippetField`](#autocomplete.prevSnippetField), and Escape
/// to [`clearSnippet`](#autocomplete.clearSnippet).
export const snippetKeymap = Facet.define<readonly KeyBinding[], readonly KeyBinding[]>({
  combine(maps) { return maps.length ? maps[0] : defaultSnippetKeymap }
})

const addSnippetKeymap = Prec.highest(keymap.compute([snippetKeymap], state => state.facet(snippetKeymap)))

/// Create a completion from a snippet. Returns an object with the
/// properties from `completion`, plus an `apply` function that
/// applies the snippet.
export function snippetCompletion(template: string, completion: Completion): Completion {
  return {...completion, apply: snippet(template)}
}

const snippetPointerHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    let active = view.state.field(snippetState, false), pos: number | null
    if (!active || (pos = view.posAtCoords({x: event.clientX, y: event.clientY})) == null) return false
    let match = active.ranges.find(r => r.from <= pos! && r.to >= pos!)
    if (!match || match.field == active.active) return false
    view.dispatch({
      selection: fieldSelection(active.ranges, match.field),
      effects: setActive.of(active.ranges.some(r => r.field > match!.field)
        ? new ActiveSnippet(active.ranges, match.field) : null),
      scrollIntoView: true
    })
    return true
  }
})
