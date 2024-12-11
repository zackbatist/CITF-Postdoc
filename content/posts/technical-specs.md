---
author:  "Zack Batist"
date: 2024-12-11
linktitle: technical-specs
title: Technical specs for this website
weight: 1
tags:
  - website
---

I am using this website as a way to help organize and share key documents and resources.
The research protocols are in flux at this stage in the project's development, and this will make it easier to distribute up-to-date drafts with partners, while simultaneously enhancing transparency.

This post outlines the technical specifications for this website and outlines a roadmap for its further development. It will therefore be continually updated as the site evolves.

## Fundamentals
This website is based on [hugo](https://github.com/gohugoio/hugo), using the [hugo-book](https://github.com/alex-shpak/hugo-book/) theme.
I decided on hugo because I already have some passing familiarity with it, and the theme looks nice, simple, expandable and well-supported.

It is hosted on GitHub Pages using a CI workflow to automatically generate the site upon changes being pushed to the repo, which is located at https://github.com/zackbatist/CITF-Postdoc.
I'm making an effort to ensure that the site can be ported to another hosting provider if necessary.

## Citations
Since this site primarily contains academic writing, I need to integrate this with my citation workflow, and I'm using [hugo-simplecite](https://github.com/joksas/hugo-simplecite) to help accomplish this.
This works by having the [better-bibtex](https://github.com/retorquere/zotero-better-bibtex) zotero plugin generate a continually-updated CSL-JSON file containing all relevant bibliographic references, which are referenced by the custom shortcodes provided by simplecite.

Simplecite currently only supports a single numerical endnote reference style but they have plans to implement additional styles, including an author-date format which I prefer.
See [my GitHub Issue](https://github.com/joksas/hugo-simplecite/issues/6) inquiring about this.

I tried using [hugo-cite](https://github.com/loup-brun/hugo-cite/), which simplecite is derived from, but I could not get it to work properly. It also does not seem to be maintained anymore, which prompted me to adopt simplecite instead.

## Generating PDFs
As an avid latex user, I do not really want to abandon PDFs entirely, and I'd like to figure out a way to generate PDF versions of the text rendered on the website.
This could probably be accomplished using pandoc running through a CI workflow.

These PDFs will be tracked with git and I'll configure a latex template to generate timestamps and references to their corresponding web versions.

## Archiving and Version Control
Every change is tracked using git.
However I would also like to find a way to archive each research protocol in Zenodo so that they can be assigned stable DOIs and detailed metadata, which will make them easier to reference.

I do not want to rely on Zenodo's GitHub integration for two reasons: 1) I want this to be as platform-agnostic as possible, and 2) that system relies on GitHub's release system which operates on the level of the whole repository rather than specific files.
I might be able to write a custom CI workflow to archive specific files to Zenodo using their API.
However, I want to be able to toggle this option, rather than have it occur for every single detected change.
Maybe I can accomplish this by pushing the changes that I want to archive to a dedicated branch that the CI workflow is configured to operate on.
Or it might be easier to simply do this manually, since I'm not sure I will be using it that often anyway.
