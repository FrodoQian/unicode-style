/**
 * TODO:
 *  * Use a static toolbar on mobile
 *  * Support numbers
 *  * Undo/redo needs to group style changes with the text modifications
 */

import 'sanitize.css';
import 'draft-js-inline-toolbar-plugin/lib/plugin.css';
import 'draft-js/dist/Draft.css';
import styles from './App.module.css';
import React, { Component } from 'react';
import runes from 'runes';
import { getSelectionText } from 'draftjs-utils';
import Editor from 'draft-js-plugins-editor';
import cx from 'classnames';
import { Modifier, EditorState, RichUtils, SelectionState } from 'draft-js';
import { InlineToolbar, inlineToolbarPlugin } from './Toolbar';
import Buttons from './Buttons';
import Header from './Header';

const MIN_LOWER = 'a'.charCodeAt(0);
const MAX_LOWER = 'z'.charCodeAt(0);
const MIN_UPPER = 'A'.charCodeAt(0);
const MAX_UPPER = 'Z'.charCodeAt(0);

// A styled unicode character is built up of
// two UTF-16 code points, where the first is a surrogate.
const SURROGATE = 0xd835;

// Each transform consists of a modifier for lowercase and a modifier for
// uppercase characters. To go from e.g. A to 𝔸, the character code for A, 65,
// is added to the uppercase modifier for DOUBLE, 0xdcf7, and prefixed with a
// unicode surrogate.
const TRANSFORMS = {
  DOUBLE: {
    exclusive: true,
    modifier: [0xdcf1, 0xdcf7]
  },
  SCRIPT: {
    exclusive: true,
    modifier: [0xdc55, 0xdc5b]
  },
  CODE: {
    exclusive: true,
    modifier: [0xde29, 0xde2f]
  },
  FRAKTUR: {
    exclusive: true,
    modifier: [0xdcbd, 0xdcc3]
  },
  BOLD: {
    exclusive: false,
    modifier: [0xdd8d, 0xdd93]
  },
  ITALIC: {
    exclusive: false,
    modifier: [0xddc1, 0xddc7]
  }
};

const COMBINED_TRANSFORMS = {
  BOLDITALIC: {
    modifier: [0xddf5, 0xddfb]
  }
};

// To e.g. underline a character, a
// specific unicode character is appended prior to it.
const APPENDERS = {
  UNDERLINE: '̲'
};

// Remove any CSS changes from inline styles, since we're styling by changing
// the content — not applying CSS rules.
const STYLE_MAP = {
  BOLD: {},
  UNDERLINE: {},
  ITALIC: {},
  CODE: {},
  DOUBLE: {},
  SCRIPT: {},
  FRAKTUR: {}
};

const isLower = code => code >= MIN_LOWER && code <= MAX_LOWER;
const isCapital = code => code >= MIN_UPPER && code <= MAX_UPPER;

/**
 * Since there's e.g., no unicode character for bold monospace, a few of the
 * styles are marked as exclusive. filterStyles makes sure to remove any
 * existing transforms when an exclusive style is applied. The same goes the
 * other way as well, when a common style is applied while an existing
 * exclusive style is active, the common one takes presedence.
 */
function filterStyles(oldStyles, newStyles) {
  const exclusive = newStyles.find(s => {
    const transform = TRANSFORMS[s];
    return transform && transform.exclusive;
  });

  if (exclusive) {
    const oldTransforms = oldStyles.filter(s => TRANSFORMS[s]);
    return newStyles.subtract(oldTransforms);
  }

  return newStyles;
}

/**
 * Turns e.g., BOLD and ITALIC into BOLDITALIC.
 */
function combineStyles(styles) {
  const combined = styles
    .filter(style => TRANSFORMS[style])
    .sort()
    .join('');
  const appenders = styles.map(style => APPENDERS[style]).filter(a => a);
  const transforms =
    COMBINED_TRANSFORMS[combined] ||
    styles.map(s => TRANSFORMS[s]).filter(t => t);
  return appenders.concat(transforms);
}

/**
 * Applies a transform by building characters using
 * a surrogate and a modifier from TRANSFORMS.
 */
function applyTransform(transform, text) {
  const { modifier } = transform;
  return runes(text)
    .map(char => {
      const code = char.charCodeAt(0);
      if (isCapital(code) || isLower(code)) {
        const mod = isCapital(code) ? modifier[1] : modifier[0];
        return String.fromCharCode(SURROGATE, mod + code);
      }

      return char;
    })
    .join('');
}

/**
 * Styles text using appenders by prepending each
 * character with the given appendChar.
 */
function applyAppender(appendChar, text) {
  return runes(text).reduce((str, char) => str + char + appendChar, '');
}

/**
 * Reverts the work done by applyTransform by removing the correct modifier,
 * depending on whether a character is lower- or uppercase.
 */
function removeTransform(transform, text) {
  const { modifier } = transform;
  return runes(text)
    .map(char => {
      if (char.charCodeAt(0) !== SURROGATE) {
        return char;
      }

      const code = char.charCodeAt(1);
      const [lower, upper] = modifier;
      if (MIN_LOWER + lower <= code && MAX_LOWER + lower >= code) {
        return String.fromCharCode(code - lower);
      } else if (MIN_UPPER + upper <= code && MAX_UPPER + upper >= code) {
        return String.fromCharCode(code - upper);
      }

      return char;
    })
    .join('');
}

/**
 * Removes appended characters, e.g., underline modifiers.
 */
function removeAppender(appendChar, text) {
  return text
    .split('')
    .filter(c => c !== appendChar)
    .join('');
}

/**
 * Applies the given style type to `text`.
 */
function applyStyle(style, text) {
  if (typeof style === 'string') {
    return applyAppender(style, text);
  }

  return applyTransform(style, text);
}

/**
 * Removes the given style type from `text`.
 */
function removeStyle(style, text) {
  if (typeof style === 'string') {
    return removeAppender(style, text);
  }

  return removeTransform(style, text);
}

/**
 * Draft.js resets the selection after content changes, but we'd rather
 * maintain it, so that you can apply multiple styles to the same selection in
 * succession. At the same time, abc is not the same as 𝙖𝙗𝙘 (bold) — it has a
 * different size. To maintain the same selection after a style change, we need
 * to calculate the new offsets by taking the size change into consideration.
 */
function buildSelection(oldText, newText, selection) {
  const diff = newText.length - oldText.length;
  const isBackward = selection.getIsBackward();
  const options = {
    anchorKey: selection.getAnchorKey(),
    focusKey: selection.getFocusKey(),
    isBackward: selection.getIsBackward(),
    hasFocus: true
  };

  // For backwards selections (i.e. selections from right to left), the focus
  // stays the same while the anchor moves slightly to the right:
  if (isBackward) {
    return new SelectionState({
      ...options,
      focusOffset: selection.getFocusOffset(),
      anchorOffset: selection.getAnchorOffset() + diff
    });
  }

  // Whereas for regular selections, we need to move the focus:
  return new SelectionState({
    ...options,
    focusOffset: selection.getFocusOffset() + diff,
    anchorOffset: selection.getAnchorOffset()
  });
}

class App extends Component {
  state = {
    editorState: EditorState.createEmpty()
  };

  handleKeyCommand = (command, editorState) => {
    const newState = RichUtils.handleKeyCommand(editorState, command);
    if (newState) {
      this.onChange(newState);
      return 'handled';
    }

    return 'not-handled';
  };

  handleBeforeInput = (str, editorState) => {
    const style = editorState.getCurrentInlineStyle();
    const selection = editorState.getSelection();
    const content = editorState.getCurrentContent();
    const styledText = combineStyles(style).reduce(
      (text, style) => applyStyle(style, text),
      str
    );

    const newState = EditorState.push(
      editorState,
      Modifier.replaceText(content, selection, styledText, style),
      'insert-characters'
    );

    this.onChange(newState);
    return 'handled';
  };

  onChange = editorState => {
    const currentContent = this.state.editorState.getCurrentContent();
    const currentStyle = this.state.editorState.getCurrentInlineStyle();
    const rawStyle = editorState.getCurrentInlineStyle();
    const newContent = editorState.getCurrentContent();
    const lastChange = editorState.getLastChangeType();
    if (
      currentContent === newContent ||
      lastChange !== 'change-inline-style' ||
      currentStyle === rawStyle
    ) {
      return this.setState({ editorState });
    }

    const selection = editorState.getSelection();
    const newStyle = filterStyles(currentStyle, rawStyle);
    const content = editorState.getCurrentContent();
    const currentText = getSelectionText(editorState);

    // To go from e.g. bold to bold and italics, we need to first remove the
    // existing bold styling, before applying both bold and italics together in
    // one pass:
    const rawText = combineStyles(currentStyle).reduce(
      (text, style) => removeStyle(style, text),
      currentText
    );

    const styledText = combineStyles(newStyle).reduce(
      (text, style) => applyStyle(style, text),
      rawText
    );

    const replaced = Modifier.replaceText(
      content,
      selection,
      styledText,
      newStyle
    );

    const newState = EditorState.push(
      editorState,
      replaced,
      'change-inline-style'
    );

    // Calculate the new selection and force it, so that it doesn't get
    // collapsed by Draft.js when the content changes:
    const newSelection = buildSelection(currentText, styledText, selection);
    this.setState({
      editorState: EditorState.forceSelection(newState, newSelection)
    });
  };

  componentDidMount() {
    this.refs.editor.focus();
  }

  render() {
    const { editorState } = this.state;
    const plainText = editorState.getCurrentContent().getPlainText();
    return (
      <div className={styles.content}>
        <Header />
        <p className={cx(styles.paragraph, { [styles.faded]: plainText })}>
          Format text using unicode characters. Paste anywhere that accepts
          plain text.
        </p>
        <Editor
          ref="editor"
          placeholder="Write, highlight, and style away."
          editorState={editorState}
          handleKeyCommand={this.handleKeyCommand}
          handleBeforeInput={this.handleBeforeInput}
          onChange={this.onChange}
          plugins={[inlineToolbarPlugin]}
          customStyleMap={STYLE_MAP}
        />
        <InlineToolbar />
        <Buttons text={plainText} />
      </div>
    );
  }
}

export default App;
