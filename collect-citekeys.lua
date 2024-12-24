local citations = {}

function Cite(cite)
  for _, citation in ipairs(cite.citations) do
    citations[citation.id] = true
  end
end

function Pandoc(doc)
  local file = io.open("citekeys.txt", "w")
  for citekey, _ in pairs(citations) do
    file:write("\\citation{" .. citekey .. "}".. "\n")
  end
  file:close()
end