# AR V2.1 role and approval matrix

| Action | Finance operator | Finance manager | Business execution | Admin/CEO | AI |
|---|---:|---:|---:|---:|---:|
| Import/preview statement | yes | yes | no | yes | read only |
| Create matching proposal | yes | yes | context only | yes | proposal only |
| Create receipt/allocation proposal | yes | yes | no | yes | no |
| Approve allocation/adjustment | no | yes | no | override with reason | no |
| Reverse/refund/write off | no | yes | no | override with reason | no |
| Generate draft statement | yes | yes | no | yes | no |
| Issue/supersede statement | no | yes | no | yes | no |

Server actions recheck authentication and role. Database RPCs use `auth.uid()` rather than actor IDs supplied by clients. New financial tables expose no direct authenticated write policy.
