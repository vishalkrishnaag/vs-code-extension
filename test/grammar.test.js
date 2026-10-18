"use strict";
// The TextMate grammar: every pattern must compile, and the rules for the current syntax must match what they are
// for. (Oniguruma and JavaScript agree on these patterns; the scopes were also checked with vscode-textmate.)

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const grammar = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "syntaxes", "felidae.tmLanguage.json"), "utf8"));
let pass = 0;
const check = (name, actual, expected) => { assert.deepStrictEqual(actual, expected, name); pass++; };

const rules = new Map();
(function collect(node, trail) {
  if (Array.isArray(node)) return node.forEach((n) => collect(n, trail));
  if (!node || typeof node !== "object") return;
  for (const key of ["match", "begin", "end"]) {
    if (typeof node[key] === "string") {
      let regex;
      assert.doesNotThrow(() => { regex = new RegExp(node[key]); }, trail + " " + key + ": " + node[key]);
      pass++;
      if (key === "match" && node.name) rules.set(node.name + "|" + node.match, regex);
    }
  }
  for (const [key, value] of Object.entries(node)) if (typeof value === "object") collect(value, trail + "/" + key);
})(grammar, "");

const scopesMatching = (text) => [...rules].filter(([, regex]) => regex.test(text)).map(([key]) => key.split("|")[0]);
const has = (text, scope) => scopesMatching(text).includes(scope);

check("PascalCase types are types", has("Integer", "storage.type.primitive.felidae"), true);
check("generic types are types", has("Optional", "storage.type.primitive.felidae"), true);
check("removed lowercase type spellings are not types", has("string", "storage.type.primitive.felidae") || has("number", "storage.type.primitive.felidae"), false);
check("define declares a function", has("define", "keyword.declaration.function.felidae"), true);
check("define before a function head is a function declaration", has("define add(a: Integer, b: Integer) =>", "keyword.declaration.function.felidae"), true);
check("def before a function head is a function declaration", has("def area(w: Double) =>", "keyword.declaration.function.felidae"), true);
check("def before a binding is a variable declaration", has("def total := 1.", "keyword.declaration.variable.felidae"), true);
check("def before a typed field is a variable declaration", has("def id: String.", "keyword.declaration.variable.felidae"), true);
check("static class is a modifier", has("static class Tally", "storage.modifier.static.felidae"), true);
check("private class is a modifier", has("private class Secret", "storage.modifier.static.felidae"), true);
check("primitive types are types", has("def count: int", "storage.type.primitive.felidae"), true);
check("the fact annotation is an annotation", has("@fact", "storage.type.annotation.felidae"), true);
check("import is a keyword", has("import java.util.ArrayList", "keyword.control.import.Felidae"), true);
check("package is a keyword", has("package com.acme", "keyword.control.import.Felidae"), true);
check("an imported Java name is scoped", has("import java.util.*", "entity.name.type.import.felidae"), true);
check("@mixfix is an annotation", has("@mixfix(pattern: 'a b')", "storage.type.annotation.felidae"), true);
check("nil and booleans are constants", [has("nil", "constant.language.felidae"), has("true", "constant.language.felidae")], [true, true]);
check("and/or/not are logical operators", has("not x", "keyword.operator.logical.word.felidae"), true);
check("Long and Float literal suffixes are numbers", [has("5L", "constant.numeric.Felidae"), has("2.5f", "constant.numeric.Felidae")], [true, true]);
check("a statement-ending dot is a terminator", has("x := 1.", "punctuation.terminator.statement.felidae"), true);
check("Link and Unlink are builtins", [has("Link(from: a)", "support.function.builtin.felidae"), has("Unlink(from: a)", "support.function.builtin.felidae")], [true, true]);
check("// is a line comment", has("// note", "comment.line.double-slash.felidae"), true);
const comment = (name) => grammar.repository.comments.patterns.find((p) => p.name === name);
check("/* opens a block comment that */ closes", [new RegExp(comment("comment.block.felidae").begin).test("/* note"), new RegExp(comment("comment.block.felidae").end).test("end */")], [true, true]);
check("/** opens a documentation comment", [new RegExp(comment("comment.block.documentation.felidae").begin).test("/** note"), new RegExp(comment("comment.block.documentation.felidae").begin).test("/**/")], [true, false]);
check("# is no longer a comment", [has("# note", "comment.line.double-slash.felidae"), has("# note", "invalid.illegal.comment.removed-number-sign.felidae")], [false, true]);
check("static init is a modifier and a keyword", [has("static init", "storage.modifier.static.felidae"), has("static init", "keyword.control.init.felidae")], [true, true]);
check("abstract is a class modifier", has("abstract class Shape", "storage.modifier.static.felidae"), true);
check("?. and ?: are operators", [has("a?.b", "keyword.operator.rule.Felidae"), has("a ?: b", "keyword.operator.rule.Felidae")], [true, true]);
check("a def with a result type is a function declaration", has("def area(): double =>", "keyword.declaration.function.felidae"), true);
check("the old relational words are not keywords", has("where", "keyword.control.felidae"), false);

console.log(`${pass} passed, 0 failed`);
