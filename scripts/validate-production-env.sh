#!/usr/bin/env bash

set +x

validate_production_env() {
  local env_file="${1:-.env}"

  if [[ ! -f "$env_file" || -L "$env_file" || ! -s "$env_file" ]]; then
    printf '%s\n' '.env debe existir como archivo regular no vacío' >&2
    return 1
  fi

  awk '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }

    function normalize(value, first, last) {
      gsub(/\r/, "", value)
      value = trim(value)
      while (length(value) >= 2) {
        first = substr(value, 1, 1)
        last = substr(value, length(value), 1)
        if ((first == "\"" && last == "\"") || (first == sprintf("%c", 39) && last == sprintf("%c", 39))) {
          value = trim(substr(value, 2, length(value) - 2))
        } else {
          break
        }
      }
      return tolower(trim(value))
    }

    function strip_inline_comment(value, i, first, quote, character, escaped, rest) {
      first = 1
      while (first <= length(value) && substr(value, first, 1) ~ /[[:space:]]/) first++
      quote = substr(value, first, 1)

      if (quote == "\"" || quote == sprintf("%c", 39)) {
        escaped = 0
        for (i = first + 1; i <= length(value); i++) {
          character = substr(value, i, 1)
          if (quote == "\"" && escaped) {
            escaped = 0
            continue
          }
          if (quote == "\"" && character == "\\") {
            escaped = 1
            continue
          }
          if (character == quote) {
            rest = substr(value, i + 1)
            if (rest ~ /^[[:space:]]+#/) {
              inline_comment = 1
              return substr(value, 1, i)
            }
            return value
          }
        }
        return value
      }

      for (i = 1; i <= length(value); i++) {
        if (substr(value, i, 1) == "#" && i > 1 && substr(value, i - 1, 1) ~ /[[:space:]]/) {
          inline_comment = 1
          return substr(value, 1, i - 1)
        }
      }
      return value
    }

    function is_example(value) {
      return value == "pon-aqui-la-contrasena-real" \
        || value == "pon-aqui-un-secreto-largo" \
        || value == "https://calendar.google.com/calendar/u/0?cid=..." \
        || value == "smtp.example.com" \
        || value == "usuario-smtp" \
        || value == "contrasena-smtp" \
        || value == "cambia-esta-contrasena" \
        || value == "change-me-in-production"
    }

    !/^[[:space:]]*#/ && index($0, "=") {
      separator = index($0, "=")
      key = trim(substr($0, 1, separator - 1))
      if (key == "") next
      inline_comment = 0
      value = normalize(strip_inline_comment(substr($0, separator + 1)))

      if (inline_comment && (key == "ADMIN_PASSWORD" || key == "SESSION_SECRET") && !reported_inline_comment[key]) {
        printf "%s no puede tener comentarios inline en .env\n", key > "/dev/stderr"
        reported_inline_comment[key] = 1
        invalid = 1
      }

      if (is_example(value) && !reported_example[key]) {
        printf "%s conserva un valor de ejemplo en .env\n", key > "/dev/stderr"
        reported_example[key] = 1
        invalid = 1
      }

      if (key == "ADMIN_PASSWORD" || key == "SESSION_SECRET") {
        count[key]++
        values[key] = value
      }
    }

    END {
      if (count["ADMIN_PASSWORD"] == 0) {
        print "ADMIN_PASSWORD falta en .env" > "/dev/stderr"
        invalid = 1
      } else if (count["ADMIN_PASSWORD"] > 1) {
        print "ADMIN_PASSWORD debe aparecer una sola vez en .env" > "/dev/stderr"
        invalid = 1
      } else if (length(values["ADMIN_PASSWORD"]) < 8) {
        print "ADMIN_PASSWORD debe tener al menos 8 caracteres" > "/dev/stderr"
        invalid = 1
      }

      if (count["SESSION_SECRET"] == 0) {
        print "SESSION_SECRET falta en .env" > "/dev/stderr"
        invalid = 1
      } else if (count["SESSION_SECRET"] > 1) {
        print "SESSION_SECRET debe aparecer una sola vez en .env" > "/dev/stderr"
        invalid = 1
      } else if (length(values["SESSION_SECRET"]) < 32) {
        print "SESSION_SECRET debe tener al menos 32 caracteres" > "/dev/stderr"
        invalid = 1
      }

      exit invalid
    }
  ' "$env_file"
}
